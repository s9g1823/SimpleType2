import ZmqClient from "./ZmqClient";
import { decode } from "@msgpack/msgpack";

export interface DecodePacket {
  // Final velocities
  final_velocity_x: number;
  final_velocity_y: number;

  // Raw velocities
  raw_velocity_x: number;
  raw_velocity_y: number;

  // Smoothed velocities
  velocity_smoothed_x: number;
  velocity_smoothed_y: number;

  // Click probabilities
  left_click_probability_smoothed: number;
  raw_right_click_probability: number;
  right_click_probability_smoothed: number;
  raw_middle_click_probability: number;
  middle_click_probability_smoothed: number;
  raw_left_click_probability: number;
}

export default class VelocityZmqListener extends ZmqClient {
  static PORT = 5578;
  static TOPIC = "INTERMEDIATE_STATES";
  static PORT_CURSOR = 5577;

  static factory(): VelocityZmqListener {
    return new VelocityZmqListener(
      "VelocityListener",
      "localhost",
      VelocityZmqListener.PORT,
      VelocityZmqListener.PORT_CURSOR,
      [VelocityZmqListener.TOPIC],
      decode,
    );
  }
}
