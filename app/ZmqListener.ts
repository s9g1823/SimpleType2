import ZmqSubscribeClient from './ZmqSubscribeClient';
import { decode } from '@msgpack/msgpack';

export interface VelocityPacket {
  // Final velocities
  final_velocity_x: number;
  final_velocity_y: number;
  
  // Raw velocities
  raw_velocity_x: number;
  raw_velocity_y: number;
  
  // Smoothed velocities
  velocity_smoothed_x: number;
  velocity_smoothed_y: number;
}

export default class VelocityZmqListener extends ZmqSubscribeClient {
  static PORT = 5578;
  static TOPIC = 'INTERMEDIATE_STATES';

  static factory(): VelocityZmqListener {
    return new VelocityZmqListener(
      'VelocityListener',
      'localhost',
      VelocityZmqListener.PORT,
      [VelocityZmqListener.TOPIC],
      decode,
    );
  }
}