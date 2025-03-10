// index.ts
import { ElevenLabsClient, play } from 'elevenlabs';

const elevenlabs = new ElevenLabsClient({
  apiKey: 'YOUR_API_KEY', // Defaults to process.env.ELEVENLABS_API_KEY
});

const audio = await elevenlabs.generate({
  voice: 'Rachel',
  text: 'Hello! 你好! Hola! नमस्ते! Bonjour! こんにちは! مرحبا! 안녕하세요! Ciao! Cześć! Привіт! வணக்கம்!',
  model_id: 'eleven_multilingual_v2',
});

await play(audio);


