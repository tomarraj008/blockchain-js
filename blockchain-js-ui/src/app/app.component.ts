import { Component } from '@angular/core'
import * as Blockchain from 'blockchain-js-core'
import * as PeerToPeer from 'rencontres'
import sha256 from 'crypto-js/sha256'
import hmacSHA512 from 'crypto-js/hmac-sha512'
import Base64 from 'crypto-js/enc-base64'
import * as CryptoJS from 'crypto-js'

const NETWORK_CLIENT_IMPL = new Blockchain.NetworkClientBrowserImpl()

@Component({
  selector: 'body',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  proposedPseudo = this.guid()
  pseudo = null
  encryptMessages = false
  encryptionKey = this.guid()
  otherEncryptionKeys: string[] = []

  fullNode: Blockchain.FullNode = null
  logs: string[] = []
  state: {
    [key: string]: {
      branch: string
      head: string
      blocks: any[]
    }
  } = { "master": { branch: Blockchain.MASTER_BRANCH, head: null, blocks: [] } }
  p2pBroker: PeerToPeer.PeerToPeerBrokering
  isMining = false

  desiredNbPeers = 5

  selectedTab = 1
  selectedBranch = Blockchain.MASTER_BRANCH

  selectTab(i) {
    this.selectedTab = i
  }

  get branches() {
    return Object.getOwnPropertyNames(this.state)
  }

  accepting = new Map<string, { offerId: string; offerMessage: string }>()
  knownAcceptedMessages = new Set<string>()

  autoMining = false
  autoMiningIteration = 1
  autoP2P = false

  constructor() {
    this.p2pBroker = new PeerToPeer.PeerToPeerBrokering(`wss://${window.location.hostname}:8999/signal`,
      () => {
        this.maybeOfferP2PChannel()
      },

      (offerId, offerMessage) => {
        if (!this.autoP2P) {
          this.log(`declined offer ${offerId}:${offerMessage}, no p2p`)
          return { accepted: false, message: `nope` }
        }

        if (this.fullNode.peerInfos.length >= this.desiredNbPeers) {
          this.log(`declined offer ${offerId}:${offerMessage}, enough`)
          return { accepted: false, message: `nope` }
        }

        if (this.knownAcceptedMessages.has(offerMessage) || this.accepting.has(offerMessage)) {
          this.log(`declined offer ${offerId}:${offerMessage}`)
          return { accepted: false, message: `i know you` }
        }

        this.accepting.set(offerMessage, { offerId, offerMessage })
        setTimeout(() => this.accepting.delete(offerMessage), 5000)

        this.log(`accepted offer ${offerId}:${offerMessage}`)

        return { accepted: true, message: this.pseudo }
      },

      (description, channel) => {
        let counterPartyMessage = description.counterPartyMessage
        this.knownAcceptedMessages.add(counterPartyMessage)

        channel.on('close', () => this.knownAcceptedMessages.delete(counterPartyMessage))

        this.addPeerBySocket(channel, `p2p with ${counterPartyMessage} on channel ${description.offerId.substr(0, 5)} (as '${this.pseudo}')`)

        setTimeout(() => this.maybeOfferP2PChannel(), 500)
      }
    )

    this.p2pBroker.createSignalingSocket()

    setInterval(() => {
      if (this.fullNode.peerInfos && this.fullNode.peerInfos.length >= this.desiredNbPeers) {
        let toRemove = this.fullNode.peerInfos[Math.floor(this.fullNode.peerInfos.length * Math.random())]
        this.fullNode.removePeer(toRemove)

        this.log(`removed random node ${toRemove.id}:${toRemove.description}`)
      }
    }, 15000 + Math.random() * 45000)

    setInterval(() => {
      if (this.autoP2P && this.p2pBroker.ready)
        this.maybeOfferP2PChannel()
    }, 10000)

    this.fullNode = new Blockchain.FullNode(NETWORK_CLIENT_IMPL)

    this.fullNode.node.addEventListener('head', async (event) => {
      this.log(`new head on branch ${event.branch} : ${event.headBlockId}`)

      let state = {}

      let branch = event.branch
      let toFetch = event.headBlockId

      let branchState = {
        branch: branch,
        head: toFetch,
        blocks: []
      }

      let count = 0

      let toFetchs = [toFetch]
      while (toFetchs.length) {
        let fetching = toFetchs.shift()

        let blockMetadatas = await this.fullNode.node.blockChainBlockMetadata(fetching, 1)
        let blockMetadata = blockMetadatas && blockMetadatas[0]
        let blockDatas = await this.fullNode.node.blockChainBlockData(fetching, 1)
        let blockData = blockDatas && blockDatas[0]

        branchState.blocks.push({ blockMetadata, blockData })

        blockData && blockData.previousBlockIds && blockData.previousBlockIds.forEach(b => !toFetchs.some(bid => bid == b) && toFetchs.push(b))

        count++
        if (count > 50)
          break
      }

      state[branch] = branchState

      this.state = state
    })
  }

  setPseudo(pseudo, peerToPeer) {
    this.pseudo = pseudo
    this.autoP2P = peerToPeer

    this.maybeOfferP2PChannel()
  }

  maybeOfferP2PChannel() {
    if (this.autoP2P && this.p2pBroker.ready && this.fullNode.peerInfos.length < this.desiredNbPeers) {
      this.offerP2PChannel()
    }

    // todo remove when too much peers ?
    // todo remove unconnected peers ?
  }

  offerP2PChannel() {
    let offerId = this.p2pBroker.offerChannel(this.pseudo)
    this.log(`offered channel ${offerId}`)
  }

  addEncryptionKey(newEncryptionKey: string) {
    if (!newEncryptionKey || !newEncryptionKey.length || this.otherEncryptionKeys.includes(newEncryptionKey))
      return

    this.decypherCache.clear()

    this.otherEncryptionKeys.push(newEncryptionKey)
  }

  removeEncryptionKey(key) {
    this.otherEncryptionKeys = this.otherEncryptionKeys.filter(k => k != key)
  }

  private decypherCache = new Map<string, string>()

  decypher(message: string) {
    if (!message || message.length < 5)
      return `(invalid) ${message}`

    if (this.decypherCache.has(message))
      return this.decypherCache.get(message)

    let decypheredMessage = `(crypted) ${message}`
    for (let key of this.otherEncryptionKeys) {
      let decyphered = CryptoJS.AES.decrypt(message, key).toString(CryptoJS.enc.Utf8)
      if (!decyphered || decyphered.length < 6)
        continue

      console.log(`decy ${decyphered}`)

      let check = decyphered.substr(-3)
      decyphered = decyphered.substr(0, decyphered.length - 3)
      if (check == decyphered.substr(-3)) {
        this.decypherCache.set(message, decyphered)
        decypheredMessage = decyphered
        break
      }
    }

    this.decypherCache.set(message, decypheredMessage)

    return decypheredMessage
  }

  async mine(message: string, miningDifficulty) {
    if (this.isMining || message == '' || miningDifficulty <= 0)
      return

    this.isMining = true

    try {
      let dataItem = {
        id: this.guid(),
        author: this.pseudo,
        message,
        encrypted: false
      }

      if (this.encryptMessages && this.encryptionKey && dataItem.message.length >= 3) {
        this.addEncryptionKey(this.encryptionKey)
        dataItem.message = CryptoJS.AES.encrypt(dataItem.message + dataItem.message.substr(-3), this.encryptionKey).toString()
        dataItem.encrypted = true
      }

      this.fullNode.miner.addData(this.selectedBranch, dataItem)
      let mineResult = await this.fullNode.miner.mineData(miningDifficulty, 30)
      this.log(`mine result: ${JSON.stringify(mineResult)}`)
    }
    catch (error) {
      this.log(`error mining: ${JSON.stringify(error)}`)
    }
    finally {
      this.isMining = false
    }
  }

  log(message) {
    this.logs.unshift(message)
    if (this.logs.length > 20)
      this.logs.pop()
  }

  toggleAutoP2P() {
    if (this.autoP2P) {
      this.autoP2P = false
    }
    else {
      this.autoP2P = true
      this.maybeOfferP2PChannel()
    }
  }

  toggleAutomine(minedData, miningDifficulty, automineTimer) {
    if (this.autoMining) {
      this.autoMining = false
    }
    else {
      this.autoMining = true

      let action = async () => {
        this.autoMining && await this.mine(`${minedData} - ${this.autoMiningIteration++}`, miningDifficulty)
        if (this.autoMining)
          setTimeout(action, automineTimer)
      }
      action()
    }
  }

  async addPeer(peerHost, peerPort) {
    console.log(`add peer ${peerHost}:${peerPort}`)

    let ws = NETWORK_CLIENT_IMPL.createClientWebSocket(`wss://${peerHost}:${peerPort}/events`)

    this.addPeerBySocket(ws, `direct peer ${peerHost}:${peerPort}`)
  }

  private peersSockets = new Map<Blockchain.PeerInfo, Blockchain.WebSocket>()

  private async addPeerBySocket(ws: Blockchain.WebSocket, description: string) {
    let peerInfo: Blockchain.PeerInfo = null
    let connector = null

    ws.on('open', () => {
      console.log(`peer connected`)

      connector = new Blockchain.WebSocketConnector(this.fullNode.node, ws)

      peerInfo = this.fullNode.addPeer(connector, description)
      this.peersSockets.set(peerInfo, ws)
    })

    ws.on('error', (err) => {
      console.log(`error with peer : ${err}`)
      ws.close()
    })

    ws.on('close', () => {
      connector && connector.terminate()
      connector = null
      this.fullNode.removePeer(peerInfo.id)

      console.log('peer disconnected')
    })
  }

  disconnectPeer(peerInfo: Blockchain.PeerInfo) {
    this.fullNode.removePeer(peerInfo.id)
    let ws = this.peersSockets.get(peerInfo)
    ws && ws.close()
    this.peersSockets.delete(peerInfo)
  }

  guid() {
    //'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    return 'xxxxxxxxxx'.replace(/[xy]/g, (c) => {
      let r = Math.random() * 16 | 0
      let v = c == 'x' ? r : (r & 0x3 | 0x8)

      return v.toString(16)
    })
  }
}