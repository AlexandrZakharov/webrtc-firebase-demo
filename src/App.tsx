// App.tsx
import React, { useState, useRef } from 'react';
import './App.css';

import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
} from 'firebase/firestore';

import { pipeline, AutomaticSpeechRecognitionOutput } from '@xenova/transformers';

const firebaseConfig = {
  apiKey: 'AIzaSyDN1V-iVwPCTyvQO_jGafiCnq9aujCI4E8',
  authDomain: 'video-chat-33799.firebaseapp.com',
  databaseURL: 'https://video-chat-33799-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'video-chat-33799',
  storageBucket: 'video-chat-33799.firebasestorage.app',
  messagingSenderId: '86088207916',
  appId: '1:86088207916:web:8dda01de508282b6e2cb89',
};

const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

const servers: RTCConfiguration = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

const App: React.FC = () => {
  const [pc] = useState<RTCPeerConnection>(new RTCPeerConnection(servers));
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const callInputRef = useRef<HTMLInputElement>(null);

  const [webcamButtonDisabled, setWebcamButtonDisabled] = useState(false);
  const [callButtonDisabled, setCallButtonDisabled] = useState(true);
  const [answerButtonDisabled, setAnswerButtonDisabled] = useState(true);
  const [hangupButtonDisabled, setHangupButtonDisabled] = useState(true);

  const [transcribedText, setTranscribedText] = useState<string>('');

  // Variables for recording and processing audio
  let mediaRecorder: MediaRecorder;
  let audioChunks: Blob[] = [];

  // 1. Setup media sources
  const handleWebcamButton = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);

    const remoteStream = new MediaStream();
    setRemoteStream(remoteStream);

    // Push tracks from local stream to peer connection
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    // Pull tracks from remote stream, add to video stream
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
    };

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = stream;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }

    setCallButtonDisabled(false);
    setAnswerButtonDisabled(false);
    setWebcamButtonDisabled(true);
  };

  // 2. Create an offer
  const handleCallButton = async () => {
    const callDoc = doc(collection(firestore, 'calls'));
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    if (callInputRef.current) {
      callInputRef.current.value = callDoc.id;
    }

    // Get candidates for caller, save to db
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await addDoc(offerCandidates, event.candidate.toJSON());
      }
    };

    // Create offer
    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    await setDoc(callDoc, { offer });

    // Listen for remote answer
    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (data?.answer && !pc.currentRemoteDescription) {
        const answerDescription = new RTCSessionDescription(data.answer);
        pc.setRemoteDescription(answerDescription);
      }
    });

    // When answered, add candidate to peer connection
    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.addIceCandidate(candidate);
        }
      });
    });

    setHangupButtonDisabled(false);
  };

  // 3. Answer the call with the unique ID
  const handleAnswerButton = async () => {
    const callId = callInputRef.current?.value;
    if (!callId) return;

    const callDoc = doc(firestore, 'calls', callId);
    const answerCandidates = collection(callDoc, 'answerCandidates');
    const offerCandidates = collection(callDoc, 'offerCandidates');

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await addDoc(answerCandidates, event.candidate.toJSON());
      }
    };

    const callData = (await getDoc(callDoc)).data();
    if (!callData) return;

    const offerDescription = callData.offer;
    await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await updateDoc(callDoc, { answer });

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          pc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  };

  // 4. Start Speech Recognition
  const startSpeechRecognition = async () => {
    if (remoteStream) {
      const audioTracks = remoteStream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioStream = new MediaStream([audioTracks[0]]);
        mediaRecorder = new MediaRecorder(audioStream);

        mediaRecorder.ondataavailable = (event) => {
          audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm; codecs=opus' });
          await processAudioBlob(audioBlob);
          audioChunks = [];
        };

        mediaRecorder.start();

        // Stop recording after 5 seconds
        setTimeout(() => {
          mediaRecorder.stop();
        }, 5000);
      } else {
        alert('No audio track available in the remote stream.');
      }
    } else {
      alert('Remote stream is not available.');
    }
  };

  const processAudioBlob = async (audioBlob: Blob) => {
    // Read the audio blob as an ArrayBuffer
    const arrayBuffer = await audioBlob.arrayBuffer();

    // Decode the audio data using AudioContext
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Get the audio data from the first channel
    const audioData = audioBuffer.getChannelData(0);

    // Initialize the transcriber
    const transcriber = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en'
    );

    // Perform speech recognition
    const output = await transcriber(audioData);

    // Update the transcribed text
    if (Array.isArray(output)) {
      const combinedText = output.map((o) => o.text).join(' ');
      setTranscribedText(combinedText);
    } else {
      setTranscribedText(output.text);
    }
  };

  return (
    <div>
      <h2>1. Start your Webcam</h2>
      <button onClick={handleWebcamButton} disabled={webcamButtonDisabled}>
        Start webcam
      </button>
      <br />
      <video ref={webcamVideoRef} autoPlay playsInline controls></video>

      <h2>2. Create a new Call</h2>
      <button onClick={handleCallButton} disabled={callButtonDisabled}>
        Create Call (offer)
      </button>

      <h2>3. Join a Call</h2>
      <input ref={callInputRef} />
      <button onClick={handleAnswerButton} disabled={answerButtonDisabled}>
        Answer
      </button>

      <h2>4. Remote Stream</h2>
      <video ref={remoteVideoRef} autoPlay playsInline controls></video>
      <button disabled={hangupButtonDisabled}>Hangup</button>

      <h2>Speech Recognition</h2>
      <button onClick={startSpeechRecognition}>Start Speech Recognition</button>
      <p>Transcribed Text: {transcribedText}</p>
    </div>
  );
};

export default App
