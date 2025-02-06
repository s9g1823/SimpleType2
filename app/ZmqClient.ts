import { decode } from "@msgpack/msgpack";
import EventEmitter from "eventemitter3";
import * as zmq from "jszmq";
import { Req, Sub } from "jszmq";

export default class ZmqClient {
  events: EventEmitter;

  host: string;
  port_sub: number;
  port_pub: number;
  decode: typeof decode;
  topics: string[];
  connectionUrlSub: string;
  connectionUrlPub: string;

  hasStarted: boolean;
  startedAt: null | number;

  subscriber: null | zmq.Sub;

  static EVENT_MESSAGE = "message";

  static factory(
    namespace: string,
    host: string,
    port_sub: number,
    port_pub: number,
    topics: string[],
    decoder = decode,
  ): ZmqClient {
    return new ZmqClient(namespace, host, port_sub, port_pub, topics, decoder);
  }

  constructor(
    namespace: string,
    host: string,
    port_sub: number,
    port_pub: number,
    topics: string[],
    decoder: typeof decode,
  ) {
    // RE making a generic static factory method...

    this.events = new EventEmitter();
    this.decode = decoder;
    this.host = host;
    this.port_sub = port_sub;
    this.port_pub = port_pub;
    this.topics = topics;
    // The protocol is not configurable because websocket is the only zmq
    // tranport option in the browser.
    this.connectionUrlSub = `ws://${this.host}:${this.port_sub}`;
    this.connectionUrlPub = `ws://${this.host}:${this.port_pub}`;

    this.hasStarted = false;
    this.startedAt = null;

    this.subscriber = null;
    this.requester = null;
  }

  start(): void {
    if (this.hasStarted) {
      return;
    }

    this.startedAt = Date.now();
    this.#connect();
    this.#subscribe();

    this.hasStarted = true;
  }

  stop(): void {
    if (!this.hasStarted) {
      return;
    }
    this.#unsubscribe();
    this.#disconnect();

    this.hasStarted = false;
  }

  publish(topic: string, message: string): void {
    this.requester.send([topic, message]);
  }

  #connect(): void {
    this.subscriber = new Sub();

    // @todo - how can we confirm that the connection was established?
    this.subscriber.connect(this.connectionUrlSub);

    this.requester = new Req();
    this.requester.connect(this.connectionUrlPub);
  }

  #disconnect(): void {
    if (this.subscriber !== null) {
      this.subscriber.close();
    }

    if (this.requester !== null) {
      this.requester.close();
    }

  }

  #subscribe(): void {
    if (this.subscriber === null) {
      throw new Error("`subscriber` does not exist");
    }

    this.subscriber.on(ZmqClient.EVENT_MESSAGE, (topic, message) => {
      this.events.emit(ZmqClient.EVENT_MESSAGE, this.decode(message));
    });

    this.topics.forEach((topic) => {
      if (this.subscriber === null) {
        throw new Error("`subscriber` does not exist");
      }

      // @todo - how can we confirm that the subscription was successful?
      this.subscriber.subscribe(topic);
    });
  }

  #unsubscribe(): void {
    this.topics.forEach((topic) => {
      if (this.subscriber === null) {
        throw new Error("`subscriber` does not exist");
      }

      this.subscriber.unsubscribe(topic);
    });
  }

  destroy(): void {
    this.stop();
    this.events.removeAllListeners();
  }
}
