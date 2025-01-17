const clients = {
  tcp:  require('./client/tcp').TCPClient,
  udp:  require('./client/udp').UDPClient,
  mqtt: require('./client/mqtt').MQTTClient,
  sqs:  require('./client/sqs').AWSSQSClient,
};

const QSIZE_REEVAL_CNT = 100;


class Backend {
  constructor(id, opts={}) {
    this.id = id;
    this.proto = opts.proto || "tcp";

    this.allOpts = opts;
    this.maxQueueLength = opts.maxQueueLength || 1000000; // 1 million messages; enough for us to restart a backend

    // Choose the client client protocol class
    this.clientClass = clients[this.proto];
    if (!this.clientClass) throw new Error(`Unsupported client protocol: '${this.proto}'`);

    this.reconnectInterval = 1000;
    this.queue = [];
    this.queueEvalCnt = 0;
    this.client = null;
    this.connected = false;
    this.connecting = false;
  }

  get status() {
    return this.connected ? 'connected' : this.connecting ? 'connecting' : this.client ? 'ready' : 'offline';
  }

  connect() {
    if (this.allOpts.disabled) {
      console.warn(`WARN: Not connecting since this backend (${this.id}) is disabled by configuration`);
      return;      
    }
    if (this.connected || this.connecting) {
      console.warn(`WARN: Not connecting since ${this.connected} / ${this.connecting}`);
      return;
    }

    console.info(`INFO: Connecting to backend '${this.id}' ...`);
    this.connecting = true;
    this.client = new this.clientClass({
      ...this.allOpts,
      autoReconnect: this.reconnectInterval,
    });
    this.client.on('connect', () => {
      this._tryQueueFlush();
      this.connected = true;
      this.connecting = false;
    });
    this.client.on('error', (err) => {
      console.warn(`WARN: Connection to backend '${this.id}' failed: ${err}`);
      this.connected = false;
      this.connecting = false;
      this._retryConnect();
    });
    this.client.on('disconnect', () => {
      console.warn(`WARN: Connection to backend '${this.id}' was lost`);
      this.connected = false;
      this._retryConnect();
    });
    this.client.connect();
  }

  _retryConnect() {
    setTimeout(() => {
      console.warn(`WARN: Reconnecting with backend '${this.id}' ...`);
      this.connect();
    }, this.reconnectInterval);
  }

  async _tryQueueFlush() {
    if (this.queue.length === 0) return;
    try {
      while (this.queue.length > 0) {
        const msg = this.queue[0];
        await this._send(msg);
        this.queue.shift();
      }
      console.info(`INFO: Backend '${this.id}' queue successfully flushed!'`);
    }
    catch(ex) {
      console.warn(`WARN: Error while trying to flush the queue after connect: ${ex}`);
    }
  }

  send(message) {
    if (!this.connected) {
      console.info(`INFO: Backend '${this.id}' not connected. Queuing message...`);
      // Check if we need to drop any messages due to the queue being full. We'll only do it every #QSIZE_REEVAL_CNT pushes
      if (this.queue.length > this.maxQueueLength && this.queueEvalCnt++ >= QSIZE_REEVAL_CNT) {
        this.queueEvalCnt = 0;
        const dropped = this.queue.splice(0, this.queue.length - this.maxQueueLength);
        console.info(`INFO: Dropped ${dropped.length} messages from the queue since it already reached maxQueueLength (${this.maxQueueLength})`);
      }

      // Queue it
      this.queue.push(message);
      if (!this.client) this.connect();
    }
    else {
      try {
        this._send(message);
      }
      catch(ex) {
        console.warn(`WARN: Error sending message to backend '${this.id}: ${ex}; Queueing message...`);
        this.queue.push(message);
      }
    }
  }

  _send(message) {
    this.client.send(message);
  }
}

module.exports = {
  Backend,
};
