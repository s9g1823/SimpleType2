import { ElevenLabsClient, play } from "elevenlabs";

export async function generateSpeech() {
    const client = new ElevenLabsClient({
        apiKey: 'sk_8250e47997875596cbb784610abe1c3abaf97e8c0aace14c',
      });  
  const audio = await client.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
    text: "The first move is what sets everything in motion.",
    model_id: "eleven_multilingual_v2",
    output_format: "mp3_44100_128",
  });
  await play(audio);
}
