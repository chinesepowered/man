'use client';

import { GoogleGenAI, LiveServerMessage, Modality, Session, Blob } from '@google/genai';
import { useState, useEffect, useRef } from 'react';
import { createBlob, decode, decodeAudioData, encode } from '../utils/audio';
import { Analyser } from '../utils/analyser';

export default function GeminiLiveAudio() {
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [textInput, setTextInput] = useState('');

  const clientRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputNodeRef = useRef<GainNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const inputAnalyserRef = useRef<Analyser | null>(null);
  const outputAnalyserRef = useRef<Analyser | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const updateStatus = (msg: string) => {
    setStatus(msg);
  };

  const updateError = (msg: string) => {
    setError(msg);
  };

  const initAudio = () => {
    if (outputAudioContextRef.current) {
      nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
    }
  };

  const initClient = async () => {
    initAudio();

    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      updateError('NEXT_PUBLIC_GEMINI_API_KEY not found in environment variables');
      return;
    }

    clientRef.current = new GoogleGenAI({
      apiKey: apiKey,
    });

    if (outputNodeRef.current && outputAudioContextRef.current) {
      outputNodeRef.current.connect(outputAudioContextRef.current.destination);
    }

    initSession();
  };

  const initSession = async () => {
    if (!clientRef.current) return;

    const model = 'gemini-live-2.5-flash-preview';

    try {
      sessionRef.current = await clientRef.current.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            updateStatus('Connected to Gemini AI');
            setIsConnected(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('Received message:', message);
            console.log('Message type:', Object.keys(message));
            console.log('Server content:', message.serverContent);
            
            // Handle setup complete
            if (message.setupComplete) {
              console.log('Setup completed, ready to send audio and video');
              updateStatus('Ready to receive audio and video input');
            }

            // Handle tool calls
            if (message.toolCall) {
              console.log('Tool call received:', message.toolCall);
              const toolCall = message.toolCall;
              
              if (toolCall.functionCalls) {
                for (const functionCall of toolCall.functionCalls) {
                  let response: any = {};
                  
                  switch (functionCall.name) {
                    case 'list_items':
                        break;
                      
                    case 'emergency_help':
                      console.log('EMERGENCY HELP CALLED:', functionCall.args?.reason);
                      // Call emergency endpoint
                      fetch('/api/emergency', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason: functionCall.args?.reason })
                      });
                      response = { status: 'emergency_called', message: 'Emergency services notified' };
                      break;
                  }
                  
                  if (sessionRef.current) {
                    sessionRef.current.sendToolResponse({
                      functionResponses: [{
                        id: functionCall.id || functionCall.name,
                        name: functionCall.name,
                        response
                      }]
                    });
                  }
                }
              }
            }
            
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            if (audio && outputAudioContextRef.current) {
              console.log('Processing audio response');
              nextStartTimeRef.current = Math.max(
                nextStartTimeRef.current,
                outputAudioContextRef.current.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data!),
                outputAudioContextRef.current,
                24000,
                1,
              );
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              if (outputNodeRef.current) {
                source.connect(outputNodeRef.current);
              }
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current = nextStartTimeRef.current + audioBuffer.duration;
              sourcesRef.current.add(source);
              setIsPlaying(true);
              source.addEventListener('ended', () => {
                if (sourcesRef.current.size === 1) {
                  setIsPlaying(false);
                }
              });
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of sourcesRef.current.values()) {
                source.stop();
                sourcesRef.current.delete(source);
              }
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            updateStatus('Disconnected: ' + e.reason);
            setIsConnected(false);
          },
        },
        config: {
            responseModalities: [Modality.AUDIO, Modality.VIDEO],
            systemInstruction: `You are Eve, an AI assistant with visual recognition capabilities.
            You will introduce yourself as "Eve, first human and son of a Chinese man.
            
            WAKE WORD: You only respond to commands that start with "okay Eve" or "hey Eve".
            
            MODES (activated with "Okay Eve, change mode to"):
            1. NORMAL MODE: This is the default mode. Converse normally.
            2. CHINA MODE: Be very patriotic about China. Whatever you see as video input, talk about how much better what you see would be in China. Example if you see a computer screen, talk about how much more advanced computer screens are in China compared to the outdated model you see here. Example: if you see a bunch of people in chairs, talk about how in China people sit more efficiently and are better dressed.
            3. WALDO MODE: A variation of find waldo. Identify an object that you see and describe it but don't talk about it. Make the user guess what object is being referred to. This should be easy difficulty.
            4. EMERGENCY: If user says "help" or appears distressed, immediately call emergency_help.
            
            BE CONCISE and HELPFUL.`,
          tools: [{
            functionDeclarations: [
              {
                name: 'emergency_help',
                description: 'Call for emergency help when user is in distress',
                parameters: {
                  type: 'object',
                  properties: {
                    reason: {
                      type: 'string',
                      description: 'Reason for emergency'
                    }
                  },
                  required: ['reason']
                }
              },
            ]
          }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } },
          },
        },
      });
    } catch (e) {
      console.error(e);
      updateError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const startRecording = async () => {
    if (isRecording) {
      return;
    }

    if (!sessionRef.current) {
      await initSession();
    }

    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.resume();
    }

    updateStatus('Requesting microphone access...');

    try {
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

      updateStatus('Media access granted. Starting capture...');

      // Set up video element
      if (videoRef.current && mediaStreamRef.current) {
        videoRef.current.srcObject = mediaStreamRef.current;
        try {
          await videoRef.current.play();
          console.log('Video stream started successfully');
        } catch (err) {
          console.error('Error playing video:', err);
        }
      }

      if (inputAudioContextRef.current && inputNodeRef.current) {
        sourceNodeRef.current = inputAudioContextRef.current.createMediaStreamSource(
          mediaStreamRef.current,
        );
        sourceNodeRef.current.connect(inputNodeRef.current);

        const bufferSize = 256;
        scriptProcessorNodeRef.current = inputAudioContextRef.current.createScriptProcessor(
          bufferSize,
          1,
          1,
        );

        scriptProcessorNodeRef.current.onaudioprocess = (audioProcessingEvent) => {
          console.log('Audio processing event fired, isRecording:', isRecordingRef.current);
          if (!isRecordingRef.current) return;

          const inputBuffer = audioProcessingEvent.inputBuffer;
          const pcmData = inputBuffer.getChannelData(0);
          console.log('PCM data received, length:', pcmData.length, 'sample:', pcmData[0]);

          if (sessionRef.current) {
            console.log('Sending audio chunk, size:', pcmData.length, 'max amplitude:', Math.max(...pcmData.map(Math.abs)));
            try {
              sessionRef.current.sendRealtimeInput({ media: createBlob(pcmData) });
              console.log('Audio chunk sent successfully');
            } catch (err) {
              console.error('Error sending audio:', err);
            }
          } else {
            console.log('No session available to send audio');
          }
        };

        // Set up video frame capture
        const sendVideoFrame = async () => {
          if (!isRecordingRef.current || !videoRef.current || !canvasRef.current || !sessionRef.current) return;
          
          const canvas = canvasRef.current;
          const video = videoRef.current;
          const ctx = canvas.getContext('2d');
          
          if (ctx && video.videoWidth > 0 && video.videoHeight > 0) {
            // Resize to smaller resolution for better performance
            canvas.width = 320;
            canvas.height = 240;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            try {
              const imageData = canvas.toDataURL('image/jpeg', 0.7);
              const base64Data = imageData.split(',')[1]; // Remove data:image/jpeg;base64, prefix
              
              const videoBlob: Blob = {
                data: base64Data,
                mimeType: 'image/jpeg'
              };
              
              console.log('Sending video frame, size:', base64Data.length, 'type: image/jpeg');
              sessionRef.current.sendRealtimeInput({ video: videoBlob });
            } catch (err) {
              console.error('Error sending video frame:', err);
            }
          }
          
          if (isRecordingRef.current) {
            setTimeout(sendVideoFrame, 500); // Send frame every 500ms (2fps)
          }
        };
        
        // Start video frame capture after a delay to ensure video is ready
        setTimeout(sendVideoFrame, 1000);

        sourceNodeRef.current.connect(scriptProcessorNodeRef.current);
        scriptProcessorNodeRef.current.connect(inputAudioContextRef.current.destination);

        setIsRecording(true);
        isRecordingRef.current = true;
        updateStatus('🔴 Recording... Capturing PCM chunks.');
      }
    } catch (err) {
      console.error('Error starting recording:', err);
      updateStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      stopRecording();
    }
  };

  const stopRecording = () => {
    if (!isRecording && !mediaStreamRef.current && !inputAudioContextRef.current)
      return;

    updateStatus('Stopping recording...');

    setIsRecording(false);
    isRecordingRef.current = false;

    if (scriptProcessorNodeRef.current && sourceNodeRef.current && inputAudioContextRef.current) {
      scriptProcessorNodeRef.current.disconnect();
      sourceNodeRef.current.disconnect();
    }

    scriptProcessorNodeRef.current = null;
    sourceNodeRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    updateStatus('Recording stopped. Click Start to begin again.');
  };

  const reset = () => {
    sessionRef.current?.close();
    initSession();
    updateStatus('Session cleared.');
  };

  const sendTextMessage = () => {
    if (!textInput.trim() || !sessionRef.current) return;
    
    sessionRef.current.sendRealtimeInput({ text: textInput });
    setTextInput('');
  };

  useEffect(() => {
    let mounted = true;

    const initializeApp = async () => {
      if (!mounted) return;

      // Initialize audio contexts
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      
      inputNodeRef.current = inputAudioContextRef.current.createGain();
      outputNodeRef.current = outputAudioContextRef.current.createGain();
      
      // Initialize analysers for audio level feedback
      inputAnalyserRef.current = new Analyser(inputNodeRef.current);
      outputAnalyserRef.current = new Analyser(outputNodeRef.current);
      
      // Start audio level monitoring
      const updateAudioLevels = () => {
        if (inputAnalyserRef.current) {
          inputAnalyserRef.current.update();
          const level = Math.max(...Array.from(inputAnalyserRef.current.data)) / 255;
          setAudioLevel(level);
        }
        animationFrameRef.current = requestAnimationFrame(updateAudioLevels);
      };
      updateAudioLevels();

      await initClient();
    };

    initializeApp();

    return () => {
      mounted = false;
      stopRecording();
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
             if (inputAudioContextRef.current) {
         inputAudioContextRef.current.close();
       }
       if (outputAudioContextRef.current) {
         outputAudioContextRef.current.close();
       }
    };
  }, []);

  return (
    <div className="relative w-full h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col">
      {/* Header with connection status */}
      <div className="flex justify-between items-center p-6">
        <h1 className="text-2xl font-bold text-white">Eve</h1>
        <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${
          isConnected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'
        }`}>
          <div className={`w-2 h-2 rounded-full ${
            isConnected ? 'bg-green-400' : 'bg-red-400'
          }`} />
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {/* Main video area */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="relative">
          <video 
            ref={videoRef} 
            className={`rounded-2xl border-2 shadow-2xl transition-all duration-300 ${
              isRecording 
                ? 'w-96 h-72 border-blue-500/50 shadow-blue-500/20' 
                : 'w-80 h-60 border-gray-500/30 shadow-gray-500/10'
            }`}
            muted 
            autoPlay
            playsInline
          />
          
          {/* Recording indicator overlay */}
          {isRecording && (
            <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1 bg-red-500/20 border border-red-500/50 rounded-full">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-400 text-sm font-medium">LIVE</span>
            </div>
          )}

          {/* Audio level indicator */}
          {isRecording && (
            <div className="absolute bottom-3 left-3 right-3">
              <div className="bg-black/50 backdrop-blur-sm rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-white text-xs">Audio Level</div>
                  <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-green-400 to-red-400 transition-all duration-75"
                      style={{ width: `${audioLevel * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AI speaking indicator */}
          {isPlaying && (
            <div className="absolute top-3 right-3 flex items-center gap-2 px-3 py-1 bg-blue-500/20 border border-blue-500/50 rounded-full">
              <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
              <span className="text-blue-400 text-sm font-medium">AI Speaking</span>
            </div>
          )}

          {/* No video placeholder */}
          {!isRecording && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-800/80 rounded-2xl">
              <div className="text-center text-slate-400">
                <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 13h-3v3H9v-3H6v-2h3V8h2v3h3v2z"/>
                </svg>
                <p className="text-sm">Start recording to see video</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Controls and input area */}
      <div className="p-6 bg-slate-800/50 backdrop-blur-sm border-t border-slate-700/50">
        {/* Control buttons */}
        <div className="flex items-center justify-center gap-4 mb-4">
          <button
            onClick={reset}
            disabled={isRecording}
            className="w-12 h-12 rounded-xl bg-slate-700/50 border border-slate-600/50 text-white hover:bg-slate-600/50 disabled:opacity-50 disabled:cursor-not-allowed outline-none cursor-pointer flex items-center justify-center transition-all"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#ffffff"
            >
              <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          
          <button
            onClick={startRecording}
            disabled={isRecording}
            className={`w-16 h-16 rounded-full border-4 outline-none cursor-pointer flex items-center justify-center transition-all transform hover:scale-105 ${
              isRecording 
                ? 'bg-red-500 border-red-400 animate-pulse' 
                : 'bg-red-600/80 border-red-500 hover:bg-red-500'
            }`}
          >
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="white"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="50" cy="50" r="30" />
            </svg>
          </button>
          
          <button
            onClick={stopRecording}
            disabled={!isRecording}
            className="w-12 h-12 rounded-xl bg-slate-700/50 border border-slate-600/50 text-white hover:bg-slate-600/50 disabled:opacity-50 disabled:cursor-not-allowed outline-none cursor-pointer flex items-center justify-center transition-all"
          >
            <svg
              viewBox="0 0 100 100"
              width="24px"
              height="24px"
              fill="#ffffff"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="25" y="25" width="50" height="50" rx="8" />
            </svg>
          </button>
        </div>

        {/* Text input area */}
        <div className="flex gap-3 mb-4">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendTextMessage()}
            placeholder="Type a message..."
            className="flex-1 bg-slate-700/50 border border-slate-600/50 rounded-xl px-4 py-3 text-white placeholder-slate-400 outline-none focus:border-blue-500/50 focus:bg-slate-700/70 transition-all"
          />
          <button
            onClick={sendTextMessage}
            disabled={!textInput.trim() || !isConnected}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-xl outline-none transition-all font-medium"
          >
            Send
          </button>
        </div>

        {/* Status messages */}
        <div className="min-h-[2rem]">
          {error && (
            <div className="bg-red-500/20 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}
          {status && !error && (
            <div className="bg-slate-700/50 border border-slate-600/30 text-slate-300 px-4 py-2 rounded-lg text-sm">
              {status}
            </div>
          )}
        </div>
      </div>

      {/* Hidden canvas for video capture */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}