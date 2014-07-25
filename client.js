// TODO:
// - republish at regular intervals
// - When receiving any message, attempt to add the node to the table
// - Accept responses even after timeout. no point to throwing them away
// - handle 'ping' event for when bucket gets full
// - Use a fast Set to make addPeer / removePeer faster
// - dht should support adding a node when you don't know the nodeId (for PORT message)

module.exports = DHT

var bencode = require('bencode')
var bufferEqual = require('buffer-equal')
var compact2string = require('compact2string')
var crypto = require('crypto')
var debug = require('debug')('bittorrent-dht')
var dgram = require('dgram')
var dns = require('dns')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var KBucket = require('k-bucket')
var once = require('once')
var parallel = require('run-parallel')
var string2compact = require('string2compact')

var BOOTSTRAP_NODES = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881'
]

var BOOTSTRAP_TIMEOUT = 10000
var K = module.exports.K = 20 // number of nodes per bucket
var MAX_CONCURRENCY = 3 // α from Kademlia paper
var ROTATE_INTERVAL = 5 * 60 * 1000 // rotate secrets every 5 minutes
var SECRET_ENTROPY = 160 // entropy of token secrets
var SEND_TIMEOUT = 2000

var MESSAGE_TYPE = {
  QUERY: 'q',
  RESPONSE: 'r',
  ERROR: 'e'
}
var ERROR_TYPE = {
  GENERIC: 201,
  SERVER: 202,
  PROTOCOL: 203, // malformed packet, invalid arguments, or bad token
  METHOD_UNKNOWN: 204
}

inherits(DHT, EventEmitter)

/**
 * A DHT client implementation. The DHT is the main peer discovery layer for BitTorrent,
 * which allows for trackerless torrents.
 * @param {string|Buffer} opts
 */
function DHT (opts) {
  var self = this
  if (!(self instanceof DHT)) return new DHT(opts)
  EventEmitter.call(self)

  if (!opts) opts = {}
  if (!opts.nodeId) opts.nodeId = hat(160)

  self.nodeId = idToBuffer(opts.nodeId)

  self._debug('new DHT %s', idToHexString(self.nodeId))

  self.ready = false
  self.listening = false
  self._binding = false
  self._destroyed = false
  self.port = null

  /**
   * Routing table
   * @type {KBucket}
   */
  self.nodes = new KBucket({
    localNodeId: self.nodeId,
    numberOfNodesPerKBucket: K,
    numberOfNodesToPing: MAX_CONCURRENCY
  })

  /**
   * Cache of routing tables used during a lookup. Saved in this object so we can access
   * each node's unique token for announces later.
   * TODO: Clean up tables after 5 minutes.
   * @type {Object} infoHash:string -> KBucket
   */
  self.tables = {}

  /**
   * Pending transactions (unresolved requests to peers)
   * @type {Object} addr:string -> array of pending transactions
   */
  self.transactions = {}

  /**
   * Peer address data (tracker storage)
   * @type {Object} infoHash:string -> array of peers
   */
  self.peers = {}

  /**
   * Lookup cache to prevent excessive GC.
   * @type {Object} addr:string -> [host:string, port:number]
   */
  self._addrData = {}

  // Create socket and attach listeners
  self.socket = dgram.createSocket('udp4')
  self.socket.on('message', self._onData.bind(self))
  self.socket.on('listening', self._onListening.bind(self))
  self.socket.on('error', function () {}) // throw away errors

  self._rotateSecrets()
  self._rotateInterval = setInterval(self._rotateSecrets.bind(self), ROTATE_INTERVAL)
  self._rotateInterval.unref()

  process.nextTick(function () {
    if (opts.bootstrap === false) {
        // Emit `ready` right away because the user does not want to bootstrap. Presumably,
        // the user will call addNode() to populate the routing table manually.
        self.ready = true
        self.emit('ready')
    } else if (typeof opts.bootstrap === 'string') {
      self._bootstrap([ opts.bootstrap ])
    } else if (Array.isArray(opts.bootstrap)) {
      self._bootstrap(fromArray(opts.bootstrap))
    } else {
      // opts.bootstrap is undefined or true
      self._bootstrap(BOOTSTRAP_NODES)
    }
  })

  self.on('ready', function () {
    self._debug('emitted ready')
  })
}

/**
 * Start listening for UDP messages on given port.
 * @param  {number} port
 * @param  {function=} onlistening added as handler for listening event
 */
DHT.prototype.listen = function (port, onlistening) {
  var self = this
  if (typeof port === 'function') {
    onlistening = port
    port = undefined
  }

  if (onlistening)
    self.once('listening', onlistening)

  if (self._destroyed || self._binding || self.listening) return
  self._binding = true

  self._debug('listen %s', port)
  self.socket.bind(port)
}

/**
 * Called when DHT is listening for UDP messages.
 */
DHT.prototype._onListening = function () {
  var self = this
  self._binding = false
  self.listening = true
  self.port = self.socket.address().port
  self._debug('emitted listening %s', self.port)
  self.emit('listening', self.port)
}

/**
 * Announce that the peer, controlling the querying node, is downloading a torrent on a
 * port.
 * @param  {string|Buffer} infoHawh
 * @param  {number} port
 * @param  {function=} cb
 */
DHT.prototype.announce = function (infoHash, port, cb) {
  var self = this
  if (!cb) cb = function () {}
  if (self._destroyed) return cb(new Error('dht is destroyed'))

  self._debug('announce start %s %s', infoHash, port)
  var infoHashHex = idToHexString(infoHash)

  // TODO: it would be nice to not use a table when a lookup is in progress
  var table = self.tables[infoHashHex]
  if (table) {
    onClosest(null, table.closest({ id: infoHash }, K))
  } else {
    self.lookup(infoHash, onClosest)
  }

  function onClosest (err, closest) {
    if (err) return cb(err)
    closest.forEach(function (contact) {
      self._sendAnnouncePeer(contact.addr, infoHash, port, contact.token)
    })
    self._debug('announce end %s %s', infoHash, port)
    cb(null)
  }
}


/**
 * Destroy and cleanup the DHT.
 * @param  {function=} cb
 */
DHT.prototype.destroy = function (cb) {
  var self = this
  if (!cb) cb = function () {}
  if (self._destroyed) return cb(new Error('dht is destroyed'))
  if (self._binding) return self.once('listening', self.destroy.bind(self, cb))
  self._debug('destroy')

  self._destroyed = true
  self.port = null

  // garbage collect large data structures
  self.nodes = null
  self.tables = null
  self.transactions = null
  self.peers = null
  self._addrData = null

  clearTimeout(self._bootstrapTimeout)
  clearInterval(self._rotateInterval)

  self.listening = false
  try {
    self.socket.close()
  } catch (err) {
    // ignore error, socket was either already closed / not yet bound
  }
  cb(null)
}

/**
 * Add a DHT node to the routing table.
 * @param {string=} addr
 * @param {string|Buffer} nodeId
 * @param {string=} from addr
 */
DHT.prototype.addNode = function (addr, nodeId, from) {
  var self = this
  if (self._destroyed) return
  nodeId = idToBuffer(nodeId)

  var contact = {
    id: nodeId,
    addr: addr
  }
  self.nodes.add(contact)
  // TODO: only emit this event for new nodes
  self.emit('node', addr, nodeId, from)
  self._debug('addNode %s %s discovered from %s', addr, idToHexString(nodeId), from)
}

/**
 * Remove a DHT node from the routing table.
 * @param  {string|Buffer} nodeId
 */
DHT.prototype.removeNode = function (nodeId) {
  var self = this
  if (self._destroyed) return
  var contact = self.nodes.get(idToBuffer(nodeId))
  if (contact) {
    self._debug('removeNode %s %s', contact.nodeId, contact.addr)
    self.nodes.remove(contact)
  }
}

/**
 * Store a peer in the DHT.
 * @param {string} addr
 * @param {Buffer|string} infoHash
 * @param {string} from addr
 */
DHT.prototype._addPeer = function (addr, infoHash, from) {
  var self = this
  if (self._destroyed) return

  infoHash = idToHexString(infoHash)

  var peers = self.peers[infoHash]
  if (!peers) {
    peers = self.peers[infoHash] = []
  }

  var compactPeerInfo = string2compact(addr)

  // TODO: make this faster using a set
  var exists = peers.some(function (peer) {
    return bufferEqual(peer, compactPeerInfo)
  })

  if (!exists) {
    peers.push(compactPeerInfo)
    self._debug('addPeer %s %s from %s', addr, infoHash, from)
    self.emit('peer', addr, infoHash, from)
  }
}

/**
 * Remove a peer from the DHT.
 * @param  {string} addr
 * @param  {Buffer|string} infoHash
 */
DHT.prototype.removePeer = function (addr, infoHash) {
  var self = this
  if (self._destroyed) return

  infoHash = idToHexString(infoHash)

  var peers = self.peers[infoHash]
  if (peers) {
    var compactPeerInfo = string2compact(addr)

    // TODO: make this faster using a set
    peers.some(function (peer, index) {
      if (bufferEqual(peer, compactPeerInfo)) {
        peers.splice(removeIndex, 1)
        self._debug('removePeer %s %s', addr, infoHash)
        return true // abort early
      }
    })
  }
}

/**
 * Join the DHT network. To join initially, connect to known nodes (either public
 * bootstrap nodes, or known nodes from a previous run of bittorrent-client).
 * @param  {Array.<string|Object>} nodes
 */
DHT.prototype._bootstrap = function (nodes) {
  var self = this

  self._debug('bootstrap with %s', JSON.stringify(nodes))

  var contacts = nodes.map(function (obj) {
    if (typeof obj === 'string') {
      return { addr: obj }
    } else {
      return obj
    }
  })

  self._resolveContacts(contacts, function (err, contacts) {
    if (err) return self.emit('error', err)
    // emit `ready` once K nodes are in the routing table so that lookups will have a
    // good chance of succeeding
    var numNodes = 0
    function onNode () {
      numNodes += 1
      if (numNodes >= K) {
        self.removeListener('node', onNode)
        process.nextTick(function () {
          if (!self.ready) {
            self.ready = true
            self.emit('ready')
          }
        })
      }
    }
    self.on('node', onNode)

    // add all non-bootstrap nodes to routing table
    contacts
      .filter(function (contact) {
        return !!contact.id
      })
      .forEach(function (contact) {
        self.addNode(contact.addr, contact.id, contact.from)
      })

    // get addresses of bootstrap nodes
    var addrs = contacts
      .filter(function (contact) {
        return !contact.id
      })
      .map(function (contact) {
        return contact.addr
      })

    function lookup () {
      self.lookup(self.nodeId, {
        findNode: true,
        addrs: addrs.length ? addrs : null
      }, function (err) {
        // if the recursive lookup terminates and we still haven't found K initial nodes
        // (i.e. 'ready' hasn't been emitted) then emit it now.
        if (!self.ready) {
          self.removeListener('node', onNode)
          self.ready = true
          self.emit('ready')
        }
      })
    }
    lookup()

    self._bootstrapTimeout = setTimeout(function () {
      // If no nodes are in the table after a timeout, retry with bootstrap nodes
      if (self.nodes.count() === 0) {
        self._debug('No DHT bootstrap nodes replied, retry')
        lookup()
      }
    }, BOOTSTRAP_TIMEOUT)
    self._bootstrapTimeout.unref()
  })
}

/**
 * Resolve the DNS for nodes whose hostname is a domain name (often the case for
 * bootstrap nodes).
 * @param  {Array.<Object>} contacts array of contact objects with domain addresses
 * @param  {function} done
 */
DHT.prototype._resolveContacts = function (contacts, done) {
  var self = this
  var tasks = contacts.map(function (contact) {
    return function (cb) {
      var addrData = self._getAddrData(contact.addr)
      dns.lookup(addrData[0], 4, function (err, host) {
        if (err) return cb(null, null)
        contact.addr = host + ':' + addrData[1]
        cb(null, contact)
      })
    }
  })
  parallel(tasks, function (err, contacts) {
    if (err) return done(err)
    // filter out hosts that don't resolve
    contacts = contacts.filter(function (contact) { return !!contact })
    done(null, contacts)
  })
}

/**
 * Perform a recurive node lookup for the given nodeId. If isFindNode is true, then
 * `find_node` will be sent to each peer instead of `get_peers`.
 * @param {Buffer|string} id node id or info hash
 * @param {Object=} opts
 * @param {boolean} opts.findNode
 * @param {Array.<string>} opts.addrs
 * @param {function} cb called with K closest nodes
 */
DHT.prototype.lookup = function (id, opts, cb) {
  var self = this
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  id = idToBuffer(id)
  if (!opts) opts = {}
  if (!cb) cb = function () {}
  cb = once(cb)

  if (self._destroyed) return cb(new Error('dht is destroyed'))
  if (!self.listening) return self.listen(self.lookup.bind(self, id, opts, cb))

  var idHex = idToHexString(id)
  self._debug('lookup %s', idHex)

  var table = self.tables[idHex] = new KBucket({
    localNodeId: id,
    numberOfNodesPerKBucket: K,
    numberOfNodesToPing: MAX_CONCURRENCY
  })

  var queried = {}
  var pending = 0 // pending queries

  if (opts.addrs) {
    // kick off lookup with explicitly passed nodes (usually, bootstrap servers)
    opts.addrs.forEach(query)
  } else if (self.nodes.count() > 0) {
    // kick off lookup with nodes in the main table
    queryClosest()
  } else {
    // Wait until at least K nodes are available, so we're more confident that a
    // lookup will succeed. If there were not many nodes and most/all were bad, then
    // lookup would terminate early. We want wait until bootstrapping has found peers.
    self.once('ready', queryClosest)
  }

  function query (addr) {
    pending += 1
    queried[addr] = true

    if (opts.findNode) {
      self._sendFindNode(addr, id, onResponse.bind(null, addr))
    } else {
      self._sendGetPeers(addr, id, onResponse.bind(null, addr))
    }
  }

  function queryClosest () {
    self.nodes.closest({ id: id }, K).forEach(function (contact) {
      query(contact.addr)
    })
  }

  function onResponse (addr, err, res) {
    if (self._destroyed) return cb(new Error('dht is destroyed'))

    // ignore errors - they're just timeouts. ignore responses - they're handled by
    // `_sendFindNode` or `_sendGetPeers` which handle inserting new nodes into
    // the routing table. recursive lookup will terminate when there are no more closer
    // nodes to find.
    if (err) self._debug('got lookup error: %s', err.message || err)

    pending -= 1

    var nodeId = res && res.id
    var nodeIdHex = idToHexString(nodeId)
    self._debug('got lookup response %s from %s', JSON.stringify(err || res), nodeIdHex)

    // add token to the node that sent this response
    var contact = table.get(nodeId)
    if (!contact) {
      console.log('contact was not in table, adding now...', nodeId, addr)
      var contact = { id: nodeId, addr: addr }
      table.add(contact)
    }
    contact.token = res.token

    console.log(res.token)
    console.log(table.toArray())

    // add nodes to this routing table for this lookup
    if (res && res.nodes) {
      res.nodes.forEach(function (contact) {
        table.add(contact)
      })
    }

    // find closest unqueried nodes
    var candidates = table.closest({ id: id }, K)
      .filter(function (contact) {
        return !queried[contact.addr]
      })

    while (pending < MAX_CONCURRENCY && candidates.length) {
      // query as many candidates as our concurrency limit will allow
      var addr = candidates.pop().addr
      query(addr)
    }

    if (pending === 0 && candidates.length === 0) {
      // recursive lookup should terminate because there are no closer nodes to find
      self._debug('terminating lookup for ' + idToHexString(id))
      var closest = table.closest({ id: id }, K)
      self._debug('K closest nodes are:')
      closest.forEach(function (contact) {
        self._debug('  ' + contact.addr + ' ' + idToHexString(contact.id))
      })
      cb(null, closest)
    }
  }
}

/**
 * Called when another node sends a UDP message
 * @param {Buffer} data
 * @param {Object} rinfo
 */
DHT.prototype._onData = function (data, rinfo) {
  var self = this
  var addr = rinfo.address + ':' + rinfo.port

  try {
    var message = bencode.decode(data)
    if (!message) throw new Error('message is empty')
  } catch (err) {
    self._debug('invalid message %s from %s', err.message, addr)
    return
  }


  if (message.y) {
    var type = message.y.toString()
  }

  if (type === MESSAGE_TYPE.QUERY) {
    self._debug('got query %s from %s', JSON.stringify(message), addr)
    self._onQuery(addr, message)
  } else if (type === MESSAGE_TYPE.RESPONSE || type === MESSAGE_TYPE.ERROR) {
    self._debug('got response/error %s from %s', JSON.stringify(message), addr)
    self._onResponseOrError(addr, type, message)
  } else {
    self._debug('unknown message type %s', type)
  }
}

/**
 * Called when another node sends a query.
 * @param  {string} addr
 * @param  {Object} message
 */
DHT.prototype._onQuery = function (addr, message) {
  var self = this
  var query = message.q.toString()

  if (query === 'ping') {
    self._onPing(addr, message)
  } else if (query === 'find_node') {
    self._onFindNode(addr, message)
  } else if (query === 'get_peers') {
    self._onGetPeers(addr, message)
  } else if (query === 'announce_peer') {
    self._onAnnouncePeer(addr, message)
  } else {
    var errMessage = 'unexpected query type ' + query
    self._debug(errMessage)
    self._sendError(addr, message.t, ERROR_TYPE.METHOD_UNKNOWN, errMessage)
  }
}

/**
 * Called when another node sends a response or error.
 * @param  {string} addr
 * @param  {string} type
 * @param  {Object} message
 */
DHT.prototype._onResponseOrError = function (addr, type, message) {
  var self = this

  var transactionId = Buffer.isBuffer(message.t) && message.t.length === 2
    && message.t.readUInt16BE(0)

  var transaction = self.transactions[addr] && self.transactions[addr][transactionId]

  var err = null
  if (type === MESSAGE_TYPE.ERROR) {
    err = new Error(Array.isArray(message.e) ? message.e.join(' ') : undefined)
  }

  if (!transaction || !transaction.cb) {
    // unexpected message!
    if (err) {
      var errMessage = 'got unexpected error from ' + addr + ' ' + err.message
      self._debug(errMessage)
      self.emit('warning', new Error(err))
    } else {
      self._debug('got unexpected message from ' + addr + ' ' + JSON.stringify(message))
      self._sendError(addr, message.t, ERROR_TYPE.GENERIC, 'unexpected message')
    }
    return
  }
  // TODO: would be nice to verify that node's reported id matches the id we have stored
  // for them
  transaction.cb(err, message.r)
}

/**
 * Send a UDP message to the given addr.
 * @param  {string} addr
 * @param  {Object} message
 * @param  {function=} cb  called once message has been sent
 */
DHT.prototype._send = function (addr, message, cb) {
  var self = this
  if (!self.listening) return self.listen(self._send.bind(self, addr, message, cb))
  if (!cb) cb = function () {}
  var addrData = self._getAddrData(addr)
  var host = addrData[0]
  var port = addrData[1]

  if (!(port > 0 && port < 65535)) {
    return
  }

  self._debug('send %s to %s', JSON.stringify(message), addr)
  message = bencode.encode(message)
  self.socket.send(message, 0, message.length, port, host, cb)
}

/**
 * Send "ping" query to given addr.
 * @param {string} addr
 * @param {function} cb called with response
 */
DHT.prototype._sendPing = function (addr, cb) {
  var self = this

  var transactionId = self._getTransactionId(addr, cb)
  var message = {
    t: transactionIdToBuffer(transactionId),
    y: MESSAGE_TYPE.QUERY,
    q: 'ping',
    a: {
      id: self.nodeId
    }
  }
  self._debug('sent ping to ' + addr)
  self._send(addr, message)
}

/**
 * Called when another node sends a "ping" query.
 * @param  {string} addr
 * @param  {Object} message
 */
DHT.prototype._onPing = function (addr, message) {
  var self = this
  var res = {
    t: message.t,
    y: MESSAGE_TYPE.RESPONSE,
    r: {
      id: self.nodeId
    }
  }

  self._debug('got ping from %s', addr)
  self._send(addr, res)
}

/**
 * Send "find_node" query to given addr.
 * @param {string} addr
 * @param {Buffer} nodeId
 * @param {function} cb called with response
 */
DHT.prototype._sendFindNode = function (addr, nodeId, cb) {
  var self = this

  function done (err, res) {
    if (err) return cb(err)
    if (res.nodes) {
      res.nodes = parseNodeInfo(res.nodes)
      res.nodes.forEach(function (node) {
        self.addNode(node.addr, node.id, addr)
      })
    }
    cb(null, res)
  }

  var transactionId = self._getTransactionId(addr, done)
  var message = {
    t: transactionIdToBuffer(transactionId),
    y: MESSAGE_TYPE.QUERY,
    q: 'find_node',
    a: {
      id: self.nodeId,
      target: nodeId
    }
  }
  self._debug('sent find_node %s to %s', idToHexString(nodeId), addr)
  self._send(addr, message)
}

/**
 * Called when another node sends a "find_node" query.
 * @param  {string} addr
 * @param  {Object} message
 */
DHT.prototype._onFindNode = function (addr, message) {
  var self = this

  var nodeId = message.a && message.a.target

  if (!nodeId) {
    var errMessage = '`find_node` missing required `a.target` field'
    self._debug(errMessage)
    self._sendError(addr, message.t, ERROR_TYPE.PROTOCOL, errMessage)
    return
  }
  self._debug('got find_node %s from %s', idToHexString(nodeId), addr)

  // Get the target node id if it exists in the routing table. Otherwise, get the
  // K closest nodes.
  var contacts = self.nodes.get(nodeId)
    || self.nodes.closest({ id: nodeId }, K)
    || []

  if (!Array.isArray(contacts)) {
    contacts = [ contacts ]
  }

  // Convert nodes to "compact node info" representation
  var nodes = convertToNodeInfo(contacts)

  var res = {
    t: message.t,
    y: MESSAGE_TYPE.RESPONSE,
    r: {
      id: self.nodeId,
      nodes: nodes
    }
  }

  self._send(addr, res)
}

/**
 * Send "get_peers" query to given addr.
 * @param {string} addr
 * @param {Buffer|string} infoHash
 * @param {function} cb called with response
 */
DHT.prototype._sendGetPeers = function (addr, infoHash, cb) {
  var self = this
  infoHash = idToBuffer(infoHash)

  function done (err, res) {
    if (err) return cb(err)
    if (res.nodes) {
      res.nodes = parseNodeInfo(res.nodes)
      res.nodes.forEach(function (node) {
        self.addNode(node.addr, node.id, addr)
      })
    }
    if (res.values) {
      res.values = parsePeerInfo(res.values)
      res.values.forEach(function (_addr) {
        self._addPeer(_addr, infoHash, addr)
      })
    }
    cb(null, res)
  }

  var transactionId = self._getTransactionId(addr, done)
  var message = {
    t: transactionIdToBuffer(transactionId),
    y: MESSAGE_TYPE.QUERY,
    q: 'get_peers',
    a: {
      id: self.nodeId,
      info_hash: infoHash
    }
  }
  self._debug('sent get_peers %s to %s', idToHexString(infoHash), addr)
  self._send(addr, message)
}

/**
 * Called when another node sends a "get_peers" query.
 * @param  {string} addr
 * @param  {Object} message
 */
DHT.prototype._onGetPeers = function (addr, message) {
  var self = this
  var addrData = self._getAddrData(addr)

  var infoHash = message.a && message.a.info_hash
  if (!infoHash) {
    var errMessage = '`get_peers` missing required `a.info_hash` field'
    self._debug(errMessage)
    self._sendError(addr, message.t, ERROR_TYPE.PROTOCOL, errMessage)
    return
  }
  var infoHashHex = idToHexString(infoHash)
  self._debug('got get_peers %s from %s', infoHashHex, addr)

  var res = {
    t: message.t,
    y: MESSAGE_TYPE.RESPONSE,
    r: {
      id: self.nodeId,
      token: self._generateToken(addrData[0])
    }
  }

  var peers = self.peers[infoHashHex]
  if (peers) {
    // We know of peers for the target info hash. Peers are stored as an array of
    // compact peer info, so return it as-is.
    res.r.values = peers
  } else {
    // No peers, so return the K closest nodes instead.
    var contacts = self.nodes.closest({ id: infoHash }, K)
    // Convert nodes to "compact node info" representation
    res.r.nodes = convertToNodeInfo(contacts)
  }

  self._send(addr, res)
}

/**
 * Send "announce_peer" query to given host and port.
 * @param {string} addr
 * @param {Buffer|string} infoHash
 * @param {number} port
 * @param {Buffer} token
 * @param {function} cb called with response
 */
DHT.prototype._sendAnnouncePeer = function (addr, infoHash, port, token, cb) {
  var self = this
  infoHash = idToBuffer(infoHash)

  var transactionId = self._getTransactionId(addr, cb)
  var message = {
    t: transactionIdToBuffer(transactionId),
    y: MESSAGE_TYPE.QUERY,
    q: 'announce_peer',
    a: {
      id: self.nodeId,
      info_hash: infoHash,
      port: port,
      token: token,
      implied_port: 0
    }
  }
  self._debug('sent announce_peer %s %s to %s with token %s', infoHash, port, addr, token)
  self._send(addr, message)
}

/**
 * Called when another node sends a "announce_peer" query.
 * @param  {string} addr
 * @param  {Object} message
 */
DHT.prototype._onAnnouncePeer = function (addr, message) {
  var self = this
  var errMessage
  var addrData = self._getAddrData(addr)

  var infoHash = idToHexString(message.a && message.a.info_hash)
  if (!infoHash) {
    errMessage = '`announce_peer` missing required `a.info_hash` field'
    self._debug(errMessage)
    self._sendError(addr, message.t, ERROR_TYPE.PROTOCOL, errMessage)
    return
  }

  var token = message.a && message.a.token
  if (!self._isValidToken(token, addrData[0])) {
    errMessage = 'cannot `announce_peer` with bad token'
    self._sendError(addr, message.t, ERROR_TYPE.PROTOCOL, errMessage)
    return
  }

  var port = message.a.implied_port !== 0
    ? addrData[1] // use port of udp packet
    : message.a.port // use port in `announce_peer` message

  self._debug('got announce_peer %s %s from %s with token %s', infoHash, port, addr, token)

  // send acknowledgement
  var res = {
    t: message.t,
    y: MESSAGE_TYPE.RESPONSE,
    r: {
      id: self.nodeId
    }
  }
  self._send(addr, res)
}

/**
 * Send an error to given host and port.
 * @param  {string} addr
 * @param  {Buffer|number} transactionId
 * @param  {number} code
 * @param  {string} message
 */
DHT.prototype._sendError = function (addr, transactionId, code, message) {
  var self = this

  if (transactionId && !Buffer.isBuffer(transactionId)) {
    transactionId = transactionIdToBuffer(transactionId)
  }

  var message = {
    y: MESSAGE_TYPE.ERROR,
    e: [code, message]
  }

  if (transactionId) {
    message.t = transactionId
  }

  self._debug('sent error %s to %s', JSON.stringify(message), addr)
  self._send(addr, message)
}

/**
 * Given an "address:port" string, return an array [address:string, port:number].
 * Uses a cache to prevent excessive array allocations.
 * @param  {string} addr
 * @return {Array.<*>}
 */
DHT.prototype._getAddrData = function (addr) {
  var self = this
  if (!self._addrData[addr]) {
    var array = addr.split(':')
    array[1] = Number(array[1])
    self._addrData[addr] = array
  }
  return self._addrData[addr]
}

/**
 * Get a transaction id, and (optionally) set a function to be called
 * @param  {string}   addr
 * @param  {function} fn
 */
DHT.prototype._getTransactionId = function (addr, fn) {
  var self = this
  fn = once(fn)
  var reqs = self.transactions[addr]
  if (!reqs) {
    reqs = self.transactions[addr] = []
    reqs.nextTransactionId = 0
  }
  var transactionId = reqs.nextTransactionId
  reqs.nextTransactionId += 1

  function onTimeout () {
    reqs[transactionId] = null
    fn(new Error('query timed out'))
  }

  function onResponse (err, res) {
    clearTimeout(reqs[transactionId].timeout)
    reqs[transactionId] = null
    fn(err, res)
  }

  reqs[transactionId] = {
    cb: onResponse,
    timeout: setTimeout(onTimeout, SEND_TIMEOUT)
  }

  return transactionId
}

/**
 * Generate token (for response to `get_peers` query). Tokens are the SHA1 hash of
 * the IP address concatenated onto a secret that changes every five minutes. Tokens up
 * to ten minutes old are accepted.
 * @param {string} host
 * @param {Buffer=} secret force token to use this secret, otherwise use current one
 * @return {Buffer}
 */
DHT.prototype._generateToken = function (host, secret) {
  var self = this
  if (!secret) secret = self.secrets[0]
  return sha1(Buffer.concat([ new Buffer(host, 'utf8'), secret ]))
}

/**
 * Checks if a token is valid for a given node's IP address.
 *
 * @param  {Buffer} token
 * @param  {string} host
 * @return {boolean}
 */
DHT.prototype._isValidToken = function (token, host) {
  var self = this
  var validToken0 = self._generateToken(host, self.secrets[0])
  var validToken1 = self._generateToken(host, self.secrets[1])
  return bufferEqual(token, validToken0) || bufferEqual(token, validToken1)
}

/**
 * Rotate secrets. Secrets are rotated every 5 minutes and tokens up to ten minutes
 * old are accepted.
 */
DHT.prototype._rotateSecrets = function () {
  var self = this

  function createSecret () {
    return new Buffer(hat(SECRET_ENTROPY), 'hex')
  }

  // Initialize secrets array
  // self.secrets[0] is the current secret, used to generate new tokens
  // self.secrets[1] is the last secret, which is still accepted
  if (!self.secrets) {
    self.secrets = [ createSecret(), createSecret() ]
    return
  }

  self.secrets[1] = self.secrets[0]
  self.secrets[0] = createSecret()
}

/**
 * Get a string that can be used to initialize and bootstrap the DHT in the
 * future.
 * @return {Array.<Object>}
 */
DHT.prototype.toArray = function () {
  var self = this
  var nodes = self.nodes.toArray().map(function (contact) {
    // to remove properties added by k-bucket, like `distance`, etc.
    return {
      id: contact.id.toString('hex'),
      addr: contact.addr
    }
  })
  return nodes
}

DHT.prototype._debug = function () {
  var self = this
  var args = [].slice.call(arguments)
  args[0] = '[' + idToHexString(self.nodeId).substring(0, 7) + '] ' + args[0]
  debug.apply(null, args)
}

/**
 * Parse saved string
 * @param  {Array.<Object>} nodes
 * @return {Buffer}
 */
function fromArray (nodes) {
  nodes.forEach(function (node) {
    if (node.id) {
      node.id = idToBuffer(node.id)
    }
  })
  return nodes
}

/**
 * Convert "contacts" from the routing table into "compact node info" representation.
 * @param  {Array.<Object>} contacts
 * @return {Buffer}
 */
function convertToNodeInfo (contacts) {
  var self = this
  return Buffer.concat(contacts.map(function (contact) {
    return Buffer.concat([ contact.id, string2compact(contact.addr) ])
  }))
}

/**
 * Parse "compact node info" representation into "contacts".
 * @param  {Buffer} nodeInfo
 * @return {Array.<string>}  array of
 */
function parseNodeInfo (nodeInfo) {
  var contacts = []
  try {
    for (var i = 0; i < nodeInfo.length; i += 26) {
      contacts.push({
        id: nodeInfo.slice(i, i + 20),
        addr: compact2string(nodeInfo.slice(i + 20, i + 26))
      })
    }
  } catch (err) {
    self._debug('error parsing node info ' + nodeInfo)
  }
  return contacts
}

/**
 * Parse list of "compact addr info" into an array of addr "host:port" strings.
 * @param  {Array.<Buffer>} list
 * @return {Array.<string>}
 */
function parsePeerInfo (list) {
  try {
    return list.map(compact2string)
  } catch (err) {
    self._debug('error parsing peer info ' + list)
    return []
  }
}

/**
 * Ensure a transacation id is a 16-bit buffer, so it can be sent on the wire as
 * the transaction id ("t" field).
 * @param  {number|Buffer} transactionId
 * @return {Buffer}
 */
function transactionIdToBuffer (transactionId) {
  if (Buffer.isBuffer(transactionId)) {
    return transactionId
  } else {
    var buf = new Buffer(2)
    buf.writeUInt16BE(transactionId, 0)
    return buf
  }
}

/**
 * Ensure info hash or node id is a Buffer.
 * @param  {string|Buffer} id
 * @return {Buffer}
 */
function idToBuffer (id) {
  if (Buffer.isBuffer(id)) {
    return id
  } else {
    return new Buffer(id, 'hex')
  }
}

/**
 * Ensure info hash or node id is a hex string.
 * @param  {string|Buffer} id
 * @return {Buffer}
 */
function idToHexString (id) {
  if (Buffer.isBuffer(id)) {
    return id.toString('hex')
  } else {
    return id
  }
}

// Return sha1 hash **as a buffer**
function sha1 (buf) {
  return crypto.createHash('sha1').update(buf).digest()
}
