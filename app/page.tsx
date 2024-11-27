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
 const [cutoffTime, setCutoffTime] = useState(1000); // Key click cutoff time
 const [history, setHistory] = useState<string>('');;
 const [curr, setCurr] = useState<string>('');
 const inputLength = useRef(0);
 const inputValueRef = useRef('');
 const [isGPTEnabled, setIsGPTEnabled] = useState(false); // State to toggle GPT



 const keys = [
   ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
   ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
   ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
   ['clear', 'space', 'del-word'],
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
     /**const response = await axios.post(
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
     );**/
    
     const correctedWord = response.data.choices[0].message.content.trim();
     return correctedWord;
   } catch (error) {
     console.error('Error fetching GPT auto-correct:', error);
     return history; // Fall back to the original word if API fails
   }
 };




 useEffect(() => {
   if (hoveredKey && hoverStart) {
      const timer = setTimeout(() => {
        handleKeyClick(hoveredKey);
      }, cutoffTime);


      return () => clearTimeout(timer);
   }
 }, [hoveredKey, hoverStart, cutoffTime]);


 const handleKeyClick = (key: string) => {
  
   setActiveKey(key);
   setTimeout(() => setActiveKey(null), 200);


   if (key === 'backspace') {
     deleteCharacter();
     handleMouseLeave(key);
     handleMouseEnter(key);
   } else if (key === 'space') {
     inputValueRef.current = inputValueRef.current + " ";
     //setInputValue(inputValue + '_');


     inputLength.current = inputValueRef.current.length;


     console.log(inputLength.current)
     if (isGPTEnabled) {
      autocorrectLastWord(); // Only call autocorrect if GPT is enabled
    }
   } else if (key === 'del-word') {
    deleteWord(); // New functionality
  }else if (key === 'clear') {
     clearInput();
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
 const deleteWord = () => {
  // Remove only the last word, keeping the space before it
  inputValueRef.current = inputValueRef.current.replace(/(\S+)\s*$/, ''); 
  setInputValue(inputValueRef.current); // Update the displayed input
};

const clearInput = () => {
  while (inputValueRef.current.length > 0) {
    deleteCharacter();
  }
  setInputValue(inputValueRef.current);
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
    Dwell Cutoff:
    <input
      type="number"
      min="40"
      max="5000"
      value={cutoffTime}
      onChange={(e) => handleCutoffTimeChange(e.target.value)}
      style={{ margin: "10px" }}
    />
    ms
    <input
      type="range"
      min="40"
      max="5000"
      value={cutoffTime}
      onChange={(e) => handleCutoffTimeChange(e.target.value)}
      style={{ marginLeft: "10px" }}
    />
  </label>
</div>


<button
  onClick={() => setIsGPTEnabled((prev) => !prev)}
  className={`gpt-button ${isGPTEnabled ? 'enabled' : ''}`}
>
  GPT {isGPTEnabled ? 'On' : 'Off'}
</button>


     <style jsx>{`
      .cutoff-slider {
         margin-top: 20px;
         display: flex;
         align-items: center;
         gap: 20px;
         color: #ffffff;
       }


       .cutoff-slider input[type="range"] {
         cursor: pointer;
           width: 300px; /* Make slider wider */
          height: 15px; /* Increase height of the slider */
          border-radius: 10px; /* Round the slider track */
          background: #555; /* Darker background for the track */
          appearance: none; /* Remove default styles */
          margin: 0 10px;
       }


.cutoff-slider input[type="range"]::-webkit-slider-thumb {
  appearance: none; /* Remove default styles */
  width: 30px; /* Larger thumb width */
  height: 30px; /* Larger thumb height */
  border-radius: 50%; /* Round thumb */
  background: #32CD32; /* Bright green thumb */
  border: 2px solid #ffffff; /* Add white border to thumb */
  cursor: pointer;
}

.cutoff-slider input[type="range"]::-moz-range-thumb {
  width: 30px; /* Same thumb size for Firefox */
  height: 30px;
  border-radius: 50%;
  background: #32CD32;
  border: 2px solid #ffffff;
  cursor: pointer;
}

.cutoff-slider input[type="number"] {
  text-align: center;
  font-size: 1.2em; /* Larger number input font */
  padding: 8px; /* Add padding for a bigger input field */
  border-radius: 10px;
  border: 2px solid #ccc; /* Slightly thicker border */
  color: black;
  width: 100px; /* Wider number input field */
}
.clear-button {
  margin-left: 20px; /* Add spacing to the left of the button */
  padding: 10px 20px; /* Adjust padding for size */
  font-size: 1em; /* Adjust font size */
  font-weight: bold;
  color: white;
  background-color: #f04a4a; /* Bright red color */
  border: none;
  border-radius: 20px; /* Make the button rounded */
  cursor: pointer;
  transition: background-color 0.3s ease, transform 0.2s ease;
}

.clear-button:hover {
  background-color: #d43b3b; /* Darker red on hover */
  transform: scale(1.05); /* Slight enlargement on hover */
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
       --key-size: 50px; /* Adjust this value to make keys bigger */
       --font-size: 16px; /* Base font size for the key text */
     }


     body {
       font-family: 'Poppins', sans-serif; /* Apply Poppins font globally */
     }
    
     .keyboard-row {
       display: grid;
       gap: 27px;
       justify-content: center;
         margin-bottom: 27px; /* Add spacing between rows */

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
      grid-template-columns: 15% 70% 15%; /* Empty space (15%) on left and right, space bar (70%) in the center */
      gap: 10px; /* Adjust gap between columns if necessary */
      align-items: center; /* Vertically align the keys */
      justify-content: center; /* Ensure proper centering */
    }


       /* Key button styling */
       .key {
         padding: 20px 0; /* Increased padding for larger text */
         font-size: 4.2em; /* Increased font size */
         //font-weight: bold; /* Bold font */
         color: white;
         background-color: light-gray;
         border: 0px solid rgba(255, 255, 255, 0.2);
         border-radius: 0px;
         cursor: pointer;
         // transition: background 0.1s, transform 0.3s;
         text-transform: capitalize;
         display: flex;
         align-items: center;
         justify-content: center;
         //backdrop-filter: blur(5px);
         height: 150px;
         // transition-delay: 0.35s;
        //border: 2px solid white; /* Add white border around each key */
     }


      .key.space {
        grid-column: span 5;
          grid-column: 2 / 3; /* Ensure the space bar occupies the center column */

        height: 120px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
        border: 2px solid rgba(0, 0, 0, 0.3); /* Shadow outline around the whole key */
        transition: background-color 0.2s ease, box-shadow 0.2s ease; /* Smooth transitions */

      }

      .key.del-word {
        font-size: 2.7em;

      }

      .key.clear {
        font-size: 2.7em;

      }


      /* When the space key has the "bruh" class */
      .key.space.bruh {
        //background-color: rgba(211, 211, 211, 0.7); /* Light gray with slight transparency */
        backdrop-filter: blur(4px); /* Optional: Slight blur effect for a "glass-like" vibe */
          transform: none; /* Prevent scaling or size change */
      }

            /* When the space key has the "bruh" class */
      .key.space.active {
          background-color: #32CD32;

      }

      .key.backspace {
        grid-column: span 1.5;
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
      color: #32CD32;
       transform: scale(1.3); /* Slightly enlarge key */
       //  box-shadow: 0 0 10px rgba(255, 255, 255, 0.6), 0 0 20px rgba(255, 255, 255, 0.4); /* Glow effect */
      }




       /* Subtle shadow effect for keys */
       .key {
         //box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
       }


       .key.bruh {
          font-weight: 900; /* Very bold font */
       }


  .gpt-button {
    margin-top: 20px;
    padding: 10px 20px;
    font-size: 1em;
    font-weight: bold;
    color: white;
    background-color: #32CD32; /* Green color */
    border: none;
    border-radius: 20px; /* Make the button rounded */
    cursor: pointer;
    transition: background-color 0.3s ease, transform 0.2s ease;
  }

  .gpt-button:hover {
    background-color: #28a745; /* Darker green on hover */
    transform: scale(1.05); /* Slight enlargement on hover */
  }

  .gpt-button.enabled {
    background-color: #28a745; /* Darker green for enabled state */
  }

  .clear-button {
    position: fixed; /* Make the button fixed in position */
    bottom: 60px; /* Distance from the bottom */
    left: 30px; /* Distance from the right */
    padding: 20px 40px; /* Adjust padding for size */
    font-size: 1.4em; /* Adjust font size */
    font-weight: bold;
    color: white;
    background-color: #f04a4a; /* Bright red color */
    border: none;
    border-radius: 20px; /* Make the button rounded */
    cursor: pointer;
    z-index: 1000; /* Ensure it stays above other elements */
    transition: background-color 0.3s ease, transform 0.2s ease;
  }

  .clear-button:hover {
    background-color: #d43b3b; /* Darker red on hover */
    transform: scale(1.05); /* Slight enlargement on hover */
  }
  
     `}</style>
   </div>
 );
}



