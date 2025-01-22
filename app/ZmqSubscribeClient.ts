import { decode } from '@msgpack/msgpack';
import EventEmitter from 'eventemitter3';
import * as zmq from 'jszmq';
import { Sub } from 'jszmq';

export default class ZmqSubscribeClient {
  events: EventEmitter;

  host: string;
  port: number;
  decode: typeof decode;
  topics: string[];
  connectionUrl: string;

  hasStarted: boolean;
  startedAt: null | number;

  subscriber: null | zmq.Sub;

  static EVENT_MESSAGE = 'message';

  static factory (
    namespace: string,
    host: string,
    port: number,
    topics: string[],
    decoder = decode,
  ): ZmqSubscribeClient {
    return new ZmqSubscribeClient(
      namespace,
      host,
      port,
      topics,
      decoder,
    );
  }

  constructor (
    namespace: string,
    host: string,
    port: number,
    topics: string[],
    decoder: typeof decode,
  ) {

    // RE making a generic static factory method...

    this.events = new EventEmitter();
    this.decode = decoder;
    this.host = host;
    this.port = port;
    this.topics = topics;
    // The protocol is not configurable because websocket is the only zmq
    // tranport option in the browser.
    this.connectionUrl = `ws://${this.host}:${this.port}`;

    this.hasStarted = false;
    this.startedAt = null;

    this.subscriber = null;
  }

  start (): void {
    if (this.hasStarted) {
      return;
    }

    this.startedAt = Date.now();
    this.#connect();
    this.#subscribe();

    this.hasStarted = true;
  }

  stop (): void {
    if (!this.hasStarted) {
      return;
    }
    this.#unsubscribe();
    this.#disconnect();

    this.hasStarted = false;
  }

  #connect (): void {
    this.subscriber = new Sub();

    // @todo - how can we confirm that the connection was established?
    this.subscriber.connect(this.connectionUrl);
  }

  #disconnect (): void {
    if (this.subscriber === null) {
      throw new Error('`subscriber` does not exist');
    }

    // @todo - how can we confirm that the connection was terminated?
    this.subscriber.close();
  }

  #subscribe (): void {
    if (this.subscriber === null) {
      throw new Error('`subscriber` does not exist');
    }

    this.subscriber.on(ZmqSubscribeClient.EVENT_MESSAGE, (topic, message) => {
      this.events.emit(ZmqSubscribeClient.EVENT_MESSAGE, this.decode(message));
    });

    this.topics.forEach((topic) => {
      if (this.subscriber === null) {
        throw new Error('`subscriber` does not exist');
      }

      // @todo - how can we confirm that the subscription was successful?
      this.subscriber.subscribe(topic);
    });
  }

  #unsubscribe (): void {
    this.topics.forEach((topic) => {
      if (this.subscriber === null) {
        throw new Error('`subscriber` does not exist');
      }

      this.subscriber.unsubscribe(topic);
    });
  }

  destroy (): void {
    this.stop();
    this.events.removeAllListeners();
  }
}
