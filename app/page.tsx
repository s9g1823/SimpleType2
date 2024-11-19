"use client";
console.log("Loaded API Key:", process.env.NEXT_PUBLIC_OPENAI_API_KEY);


import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';


export default function Home() {
 const [hoverStart, setHoverStart] = useState<number | null>(null); // Track hover start time
 const [hoverLogs, setHoverLogs] = useState<string[]>([]); // Store hover logs
 const [inputValue, setInputValue] = useState('');
 const [hoveredKey, setHoveredKey] = useState<string | null>(null); // Track the key being hovered
 const [activeKey, setActiveKey] = useState<string | null>(null); // Track the active key for highlight
 const [deleteInterval, setDeleteInterval] = useState<NodeJS.Timeout | null>(null); // Track the interval for holding delete
 const [cutoffTime, setCutoffTime] = useState(220); // Key click cutoff time
 const [history, setHistory] = useState<string>('');;
 const [curr, setCurr] = useState<string>('');
 const inputLength = useRef(0);
 const inputValueRef = useRef('');


 const keys = [
   ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
   ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
   ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
   ['space'],
 ];


 // Autocorrect function to find the closest word
 const autocorrect = async (history: string) => {
   const prompt = `You are part of a keyboard. The user types something. And if the user spells something wrong, you correct it. If the user spells something right, you do not change it.


  If you are not sure, you also do not change it.




  For example if the user types "Helo " you only return "Hello " and nothing else.




  If they type "Hello " you return "Hello " and nothing else.




  If the user types "slfjadz " you return "slfjadz " and nothing else.
   The user just typed "${history}". Now return something. Do not put in quotes and keep the trailing space`;
  
   try {
     const response = await axios.post(
       'https://api.openai.com/v1/chat/completions',
       {
         model: 'gpt-4o',
         messages: [{ role: 'user', content: prompt }],
         max_tokens: 50,
         temperature: 0.2, // Lower temperature for deterministic results
       },
       {
         headers: {
           'Authorization': 'Bearer ' + process.env.NEXT_PUBLIC_OPENAI_API_KEY,
           'Content-Type': 'application/json',
         },
       }
     );
    
     const correctedWord = response.data.choices[0].message.content.trim();
     return correctedWord;
   } catch (error) {
     console.error('Error fetching GPT auto-correct:', error);
     return history; // Fall back to the original word if API fails
   }
 };




 useEffect(() => {
   if (hoveredKey && hoverStart) {
     if (hoveredKey === 'backspace') {
       const singleDeleteTimeout = setTimeout(() => {
         handleKeyClick(hoveredKey);
         const holdDeleteTimeout = setTimeout(() => {
           const interval = setInterval(deleteCharacter, 100);
           setDeleteInterval(interval);
         }, 700);
         setDeleteInterval(holdDeleteTimeout);
       }, cutoffTime);


       return () => {
         clearTimeout(singleDeleteTimeout);
         if (deleteInterval) clearTimeout(deleteInterval);
       };
     } else {
       const timer = setTimeout(() => {
         handleKeyClick(hoveredKey);
       }, cutoffTime);


       return () => clearTimeout(timer);
     }
   }
 }, [hoveredKey, hoverStart, cutoffTime]);


 const handleKeyClick = (key: string) => {
   console.log("API Key:", process.env.OPENAI_API_KEY);


  
   setActiveKey(key);
   setTimeout(() => setActiveKey(null), 200);


   if (key === 'backspace') {
     deleteCharacter();
   } else if (key === 'space') {
     inputValueRef.current = inputValueRef.current + " ";
     //setInputValue(inputValue + '_');


     inputLength.current = inputValueRef.current.length;


     console.log(inputLength.current)
     autocorrectLastWord();
   } else if (key === 'enter') {
     inputLength.current = inputValueRef.current.length;
     console.log(inputLength.current)
     autocorrectLastWord();
   } else { //if character
     inputValueRef.current = inputValueRef.current + key;
     //setInputValue((prev) => prev + key);
     //console.log("Input value " + inputValue);
     console.log("Input value ref " + inputValueRef.current);
   }
 };


 const deleteCharacter = () => {
   inputValueRef.current = inputValueRef.current.slice(0, -1);
 };


 const autocorrectLastWord = async () => {
   try {
     const correctedHistory = await autocorrect(inputValueRef.current.slice(0, inputLength.current));
     inputValueRef.current = correctedHistory + " " + inputValueRef.current.slice(inputLength.current);
     setInputValue(inputValueRef.current);
   } catch (error) {
     console.error('Error during autocorrect:', error);
   }
 };


 const handleMouseEnter = (key: string) => {
   setHoverStart(Date.now());
   setHoveredKey(key);
 };


 const handleMouseLeave = (key: string) => {
   if (hoverStart) {
     const duration = Date.now() - hoverStart;
     const logEntry = `Hovered over ${key} for ${duration} ms`;
     //console.log(logEntry);
     setHoverLogs((prevLogs) => [...prevLogs, logEntry]);
     setHoverStart(null);
     setHoveredKey(null);
   }


   if (key === 'backspace') {
     if (deleteInterval) {
       clearInterval(deleteInterval);
       setDeleteInterval(null);
     }
   }
 };


 const copyToClipboard = () => {
   const logsText = hoverLogs.join("\n");
   navigator.clipboard.writeText(logsText)
     .catch((error) => console.error("Failed to copy logs:", error));
 };


 const handleCutoffTimeChange = (value: string | number) => {
   const numValue = typeof value === "string" ? parseInt(value, 10) : value;
   if (!isNaN(numValue) && numValue >= 40 && numValue <= 10000) {
     setCutoffTime(numValue);
   }
 };


 return (
   <div className="container">
     <div className="input-wrapper">
       <textarea
         id="inputArea"
         rows={2}
         value={inputValueRef.current}
         placeholder="Type here..."
         readOnly
         className="input-area"
       ></textarea>
     </div>


     <div className="keyboard">
       {keys.map((row, rowIndex) => (
         <div key={rowIndex} className={`keyboard-row row-${rowIndex}`}>
           {row.map((key) => (
             <button
               key={key}
               className={`key ${key} ${activeKey === key ? 'active' : ''} ${hoveredKey === key ? 'bruh' : ''}`}
               onMouseEnter={() => handleMouseEnter(key)}
               onMouseLeave={() => handleMouseLeave(key)}
               onClick={() => handleKeyClick(key)} // Trigger click immediately
               style={{
                 transition: hoveredKey !== key ? 'background 0.4s' : 'none',
               }}
             >
               {key === 'space'
                 ? ''
                 : key === 'lshift'
                 ? '⇧ shift'
                 : key === 'rshift'
                 ? '⇧ shift'
                 : key === 'tab'
                 ? '⇥'
                 : key === 'backspace'
                 ? '⌫'
                 : key === 'enter'
                 ? '↵'
                 : key}
             </button>
           ))}
         </div>
       ))}
     </div>


     <div className="cutoff-slider">
       <label>
         Key Click Cutoff Time:
         <input
           type="number"
           min="40"
           max="10000"
           value={cutoffTime}
           onChange={(e) => handleCutoffTimeChange(e.target.value)}
           style={{ margin: "10px" }}
         />
         ms
         <input
           type="range"
           min="40"
           max="10000"
           value={cutoffTime}
           onChange={(e) => handleCutoffTimeChange(e.target.value)}
           style={{ marginLeft: "10px" }}
         />
       </label>
     </div>


     {hoverLogs.length > 0 && (
       <button onClick={copyToClipboard} className="copy-button">
         Copy
       </button>
     )}


     <style jsx>{`
      .cutoff-slider {
         margin-top: 20px;
         display: flex;
         align-items: center;
         gap: 10px;
         color: #ffffff;
       }


       .cutoff-slider input[type="range"] {
         cursor: pointer;
       }


       .cutoff-slider input[type="number"] {
         text-align: center;
         padding: 2px;
         border-radius: 5px;
         border: 1px solid #ccc;
         color: black;
       }


       /* Container styling */
       .container {
         display: flex;
         flex-direction: column;
         align-items: center;
         gap: 20px;
         min-height: 100vh;
         justify-content: center;
         background-color: rgba(30, 30, 30, 0.9);
         padding: 20px;
         min-width: 100%;
         margin: auto;
         width: 100%;
       }


      /* Input wrapper and cursor styling */
      .input-wrapper {
        position: relative;
        width: 100%;
      }


      .input-area {
        width: 100%;
        padding: 15px;
        font-size: 3.5em;
        font-weight: bold;
        color: #ffffff;
        background-color: rgba(50, 50, 50, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        backdrop-filter: blur(10px);
        outline: none;
        height: 150px;
      }


      /* Blinking cursor effect */
      .cursor {
        position: absolute;
        right: 10px;
        bottom: 10px;
        height: 2em;
        width: 3px;
        background-color: white;
        animation: blink 1s steps(2) infinite;
      }


      @keyframes blink {
        0% { opacity: 1; }
        50% { opacity: 0; }
        100% { opacity: 1; }
      }




      /* Keyboard styling */
      .keyboard {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        padding: 20px;
        background-color: rgba(40, 40, 40, 0.8);
        border-radius: 12px;
        backdrop-filter: blur(15px);
      }




     :root {
       --key-size: 60px; /* Adjust this value to make keys bigger */
       --font-size: 18px; /* Base font size for the key text */
     }


     body {
       font-family: 'Poppins', sans-serif; /* Apply Poppins font globally */
     }
    
     .keyboard-row {
       display: grid;
       gap: 8px;
       justify-content: center;
     }


     .row-0 {
       grid-template-columns: repeat(10, 1fr);
     }


     .row-1 {
       grid-template-columns: repeat(9, 1fr);
       padding: 0 calc((10% - 8px) / 2); /* Dynamically pad based on the gap */


     }


     .row-2 {
       grid-template-columns: repeat(8, 1fr);
       padding: 0 calc((20% - 8px) / 2);


     }


     .row-3 {
       display: grid;
       grid-template-columns: 80% 20%; /* Space is 80%, Return is 20% */
       gap: 8px; /* Adjust the gap as needed */
       align-items: center; /* Ensures keys are vertically aligned if needed */      }








       /* Key button styling */
       .key {
         padding: 20px 0; /* Increased padding for larger text */
         font-size: 2.7em; /* Increased font size */
         font-weight: bold; /* Bold font */
         color: white;
         background-color: light-gray;
         border: 1px solid rgba(255, 255, 255, 0.2);
         border-radius: 8px;
         cursor: pointer;
         // transition: background 0.1s, transform 0.3s;
         text-transform: capitalize;
         display: flex;
         align-items: center;
         justify-content: center;
         backdrop-filter: blur(5px);
         height: 150px;
         // transition-delay: 0.35s;
       }


      .key.space {
        grid-column: span 5;
        height: 120px;
      }




      .key.backspace {
        grid-column: span 1.5;
      }




       .key.tab,
       .key.caps,
       .key.enter,
       .key.lshift,
       .key.rshift {
         grid-column: span 1.5;
       }


      /* Active key highlight effect */
      .key.active {
        background-color: green !important;;
       //  transform: scale(1.1); /* Slightly enlarge key */
       //  box-shadow: 0 0 10px rgba(255, 255, 255, 0.6), 0 0 20px rgba(255, 255, 255, 0.4); /* Glow effect */
      }




       /* Subtle shadow effect for keys */
       .key {
         box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
       }


       .key.bruh {
         background-color: blue;
       }


       .copy-button {
         position: fixed;
         bottom: 20px;
         right: 20px;
         padding: 5px 10px;
         font-size: 12px;
         cursor: pointer;
         background-color: #888; /* Less conspicuous color */
         color: white;
         border: none;
         border-radius: 3px;
         opacity: 0.7; /* Make it slightly transparent */
         transition: opacity 0.3s ease;
       }


       .copy-button:hover {
         opacity: 0; /* Increase opacity on hover */
       }
     `}</style>
   </div>
 );
}



