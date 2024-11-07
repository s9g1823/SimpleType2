"use client"

"use client"

import React, { useState } from 'react';

export default function Home() {
  const [inputValue, setInputValue] = useState('');

  const keys = [
    ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'backspace'],
    ['tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
    ['caps', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'enter'],
    ['lshift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'rshift'],
    ['space'],
  ];

  const handleKeyClick = (key: string) => {
    if (key === 'backspace') {
      setInputValue((prev) => prev.slice(0, -1));
    } else if (key === 'space') {
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

  return (
    <div className="container">
      <textarea
        id="inputArea"
        rows={2}
        value={inputValue}
        placeholder="Type here..."
        readOnly
        className="input-area"
      ></textarea>

      <div className="keyboard">
        {keys.map((row, rowIndex) => (
          <div key={rowIndex} className={`keyboard-row row-${rowIndex}`}>
            {row.map((key) => (
              <button
                key={key}
                className={`key ${key}`}
                onClick={() => handleKeyClick(key)}
              >
                {key === 'space' ? '' : key === 'lshift' ? '⇧ shift' : key === 'rshift' ? '⇧ shift' : key === 'tab' ? '⇥' : key === 'backspace' ? '⌫' : key === 'enter' ? '↵' : key}
              </button>
            ))}
          </div>
        ))}
      </div>

      <style jsx>{`
        /* Container styling */
        .container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
          min-height: 100vh;
          justify-content: center;
          background-color: rgba(30, 30, 30, 0.9); /* Dark translucent background */
          padding: 20px;
          min-width: 100%;
          margin: auto;
          width: 100%;
        }

        /* Input text area styling */
        .input-area {
          width: 100%;
          padding: 15px;
          font-size: 1.2em;
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
          padding: 15px 0;
          font-size: 1em;
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
          height: 70px;
        }

        .key.space {
          grid-column: span 5;
          height: 70px;
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

        /* Hover and active animations for keys */
        .key:hover {
          background-color: rgba(255, 255, 255, 0.3);
          transform: translateY(-2px); /* Subtle lift effect on hover */
        }

        .key:active {
          background-color: rgba(255, 255, 255, 0.2);
          transform: translateY(0); /* Pressed effect */
        }

        /* Subtle shadow effect for keys */
        .key {
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
        }
      `}</style>
    </div>
  );
}

