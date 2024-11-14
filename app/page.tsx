"use client";

import React, { useState, useEffect } from 'react';
import wordListData from './wordList.json'; // Import the JSON file as an object

export default function Home() {
  const [hoverStart, setHoverStart] = useState<number | null>(null); // Track hover start time
  const [hoverLogs, setHoverLogs] = useState<string[]>([]); // Store hover logs
  const [inputValue, setInputValue] = useState('');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null); // Track the key being hovered
  const [activeKey, setActiveKey] = useState<string | null>(null); // Track the active key for highlight
  const [deleteInterval, setDeleteInterval] = useState<NodeJS.Timeout | null>(null); // Track the interval for holding delete

  // Convert the word list object keys to an array
  const wordList = Object.keys(wordListData);

  const keys = [
    ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'backspace'],
    ['tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
    ['caps', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'enter'],
    ['lshift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'rshift'],
    ['space'],
  ];

  // Autocorrect function to find the closest word
  const autocorrect = (word) => {
    if (wordList.includes(word)) return word; // If it's correctly spelled, return it
    
    // Find the closest word by calculating the edit distance
    let closestMatch = word;
    let minDistance = Infinity;

    wordList.forEach((correctWord) => {
      const distance = levenshteinDistance(word, correctWord);
      if (distance < minDistance) {
        minDistance = distance;
        closestMatch = correctWord;
      }
    });

    return closestMatch;
  };

  // Calculate Levenshtein Distance
  const levenshteinDistance = (a, b) => {
    const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(i));
    for (let j = 1; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        matrix[i][j] = a[i - 1] === b[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + 1);
      }
    }

    return matrix[a.length][b.length];
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
        }, 300);

        return () => {
          clearTimeout(singleDeleteTimeout);
          if (deleteInterval) clearTimeout(deleteInterval);
        };
      } else {
        const timer = setTimeout(() => {
          handleKeyClick(hoveredKey);
        }, 300);

        return () => clearTimeout(timer);
      }
    }
  }, [hoveredKey, hoverStart]);

  const handleKeyClick = (key: string) => {
    setActiveKey(key);
    setTimeout(() => setActiveKey(null), 200);

    if (key === 'backspace') {
      deleteCharacter();
    } else if (key === 'space') {
      autocorrectLastWord(); // Apply autocorrect on pressing space
      setInputValue((prev) => prev + ' ');
    } else if (key === 'enter') {
      setInputValue((prev) => prev + '\n');
    } else if (key === 'tab') {
      setInputValue((prev) => prev + '\t');
    } else if (key === 'caps' || key === 'lshift' || key === 'rshift') {
      // Caps and shift can be handled here if needed
    } else {
      setInputValue((prev) => prev + key);
    }
  };

  const deleteCharacter = () => {
    setInputValue((prev) => prev.slice(0, -1));
  };

  const autocorrectLastWord = () => {
    setInputValue((prev) => {
      const words = prev.trim().split(' ');
      const lastWord = words.pop() || '';
      const correctedWord = autocorrect(lastWord);
      return [...words, correctedWord].join(' ') + ' ';
    });
  };

  const handleMouseEnter = (key: string) => {
    setHoverStart(Date.now());
    setHoveredKey(key);
  };

  const handleMouseLeave = (key: string) => {
    if (hoverStart) {
      const duration = Date.now() - hoverStart;
      const logEntry = `Hovered over ${key} for ${duration} ms`;
      console.log(logEntry);
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
      .then(() => alert("Hover logs copied to clipboard!"))
      .catch((error) => console.error("Failed to copy logs:", error));
  };

  return (
    <div className="container">
      <div className="input-wrapper">
        <textarea
          id="inputArea"
          rows={2}
          value={inputValue}
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
                className={`key ${key} ${activeKey === key ? 'active' : ''}`}
                onMouseEnter={() => handleMouseEnter(key)}
                onMouseLeave={() => handleMouseLeave(key)}
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
     
      {hoverLogs.length > 0 && (
        <button onClick={copyToClipboard} className="copy-button">
          Copy
        </button>
      )}

      <style jsx>{`
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


       /* Row-specific styling for symmetrical layout */
       .keyboard-row {
         display: grid;
         gap: 8px;
       }


       .row-0 {
         grid-template-columns: repeat(13, 1fr) 2fr;
       }
       .row-1 {
         grid-template-columns: 1.5fr repeat(13, 1fr);
       }
       .row-2 {
         grid-template-columns: 2fr repeat(11, 1fr) 2fr;
       }
       .row-3 {
         grid-template-columns: 2.5fr repeat(10, 1fr) 2.5fr;
       }
       .row-4 {
         grid-template-columns: 1fr 1fr 7fr;
       }


        /* Key button styling */
        .key {
          padding: 20px 0; /* Increased padding for larger text */
          font-size: 2em; /* Increased font size */
          font-weight: bold; /* Bold font */
          color: #ffffff;
          background-color: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.3s, transform 0.1s;
          text-transform: capitalize;
          display: flex;
          align-items: center;
          justify-content: center;
          backdrop-filter: blur(5px);
          height: 120px;
          transition-delay: 0.35s; 
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
         background-color: rgba(255, 255, 255, 0.6); /* Brighter highlight color */
         transform: scale(1.1); /* Slightly enlarge key */
         box-shadow: 0 0 10px rgba(255, 255, 255, 0.6), 0 0 20px rgba(255, 255, 255, 0.4); /* Glow effect */
       }


        /* Subtle shadow effect for keys */
        .key {
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
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
          opacity: 1; /* Increase opacity on hover */
        }
      `}</style>
    </div>
  );
}
