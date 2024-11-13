"use client";

import React, { useState } from 'react';

export default function Home() {
  const [hoverStart, setHoverStart] = useState<number | null>(null); // Track hover start time
  const [hoverLogs, setHoverLogs] = useState<string[]>([]); // Store hover logs

  const keys = [
    ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'backspace'],
    ['tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
    ['caps', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'enter'],
    ['lshift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'rshift'],
    ['space'],
  ];

  const handleMouseEnter = (key: string) => {
    setHoverStart(Date.now()); // Record hover start time
  };

  const handleMouseLeave = (key: string) => {
    if (hoverStart) {
      const duration = Date.now() - hoverStart; // Calculate hover duration
      const logEntry = `Hovered over ${key} for ${duration} ms`; // Create log entry
      console.log(logEntry); // Log to the console

      // Add log entry to hoverLogs state
      setHoverLogs((prevLogs) => [...prevLogs, logEntry]);

      setHoverStart(null); // Reset hover start time
    }
  };

  // Function to copy logs to clipboard
  const copyToClipboard = () => {
    const logsText = hoverLogs.join("\n"); // Join logs with line breaks
    navigator.clipboard.writeText(logsText)
      .then(() => {
        alert("Hover logs copied to clipboard!");
      })
      .catch((error) => {
        console.error("Failed to copy logs:", error);
      });
  };

  return (
    <div className="container">
      <div className="keyboard">
        {keys.map((row, rowIndex) => (
          <div key={rowIndex} className={`keyboard-row row-${rowIndex}`}>
            {row.map((key) => (
              <button
                key={key}
                className={`key ${key}`}
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
     
      {/* Copy to Clipboard Button */}
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

        /* Input text area styling */
        .input-area {
          width: 100%;
          padding: 15px;
          font-size: 3.5em; /* Increased font size */
          font-weight: bold; /* Bold font */
          color: #ffffff;
          background-color: rgba(50, 50, 50, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          backdrop-filter: blur(10px);
          outline: none;
          height: 150px;
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

        .key:active {
          background-color: rgba(255, 255, 255, 0.2);
          transform: translateY(0); /* Pressed effect */
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
