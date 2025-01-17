"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import axios from "axios";
import { last } from "lodash";

require('dotenv').config()

interface Dictionary {
[t9Code: string]: string[];
}


interface OctagonSide {
startX: number;
startY: number;
endX: number;
endY: number;
}



import "@fontsource/poppins"; // Defaults to weight 400

const PointerLockDemo: React.FC = () => {
//
// ─────────────────────────────────────────────────────────────────────────────
// A) CANVAS + POINTER LOCK STATE
// ─────────────────────────────────────────────────────────────────────────────
const canvasRef = useRef<HTMLCanvasElement | null>(null);
const [position, setPosition] = useState({ x: 400, y: 300 });

// Track collision so we don’t spam the same side
const lastHitSide = useRef<number | null>();

// The lines making up the octagon, if needed for reference
const [octagonSides, setOctagonSides] = useState<OctagonSide[]>([]);




//
// ─────────────────────────────────────────────────────────────────────────────
// B) WORDS & T9 CODE
// ─────────────────────────────────────────────────────────────────────────────
// 1. `theCodes`: The codes for each word separated
// 2. `theWords`: The words (pretty much once they're finalized... unless they get popped out)
// 3. `code`: The active code being typed

const theCodes = useRef<string[]>([]);
const theWords = useRef<string[]>([]);
const code = useRef<string>("");

const dirtyWords = useRef<string[]>([]);

//
// ─────────────────────────────────────────────────────────────────────────────
// C) DICTIONARY & GPT
// ─────────────────────────────────────────────────────────────────────────────
const [dictionary, setDictionary] = useState<Dictionary>({});

//
// ─────────────────────────────────────────────────────────────────────────────
// D) SIDE MAPPINGS
// ─────────────────────────────────────────────────────────────────────────────
// If side 3 => space => finalize the current code.

const sideMappings: Record<number, string> = {
  1: "⌫",
  2: "2",
  3: " ",   // hitting space => finalize the word
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
};



// If you want bold labels around the octagon:
const getSideLabels = (type: string): Record<number, string> => {
  switch (type) {
    case "abc":
      return {
        1: "⌫",
        2: "J K L M",
        3: "␣",
        4: "N O P Q R",
        5: "S T U V",
        6: "W X Y Z",
        7: "A B C D E",
        8: "F G H I",
      };
    case "qwerty":
      return {
        1: "⌫",
        2: "J B N M",
        3: "␣",
        4: "Z X C V",
        5: "A S D F",
        6: "Q W E R",
        7: "T Y U G H",
        8: "I O P K L",
      };
    default: // optimized is default
      return {
        1: "⌫",
        2: "F U D C P",
        3: "␣",
        4: "I L Y W",
        5: "E G B V X",
        6: "A M R",
        7: "T H N Q",
        8: "S O J K Z",
      };
  }
};



//
// ─────────────────────────────────────────────────────────────────────────────
// E) LOAD DICTIONARY ONCE
// ─────────────────────────────────────────────────────────────────────────────

const [dictionaryType, setDictionaryType] = useState("qwerty");
useEffect(() => {
  fetch(`/six${dictionaryType}.json`)
    .then((res) => res.json())
    .then((data) => setDictionary(data))
    .catch((err) => console.error("Failed to load dictionary:", err));
}, [dictionaryType]);

const sideLabels = getSideLabels(dictionaryType);

//
// ─────────────────────────────────────────────────────────────────────────────
// F) GPT LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

const pickWordViaGPT = useCallback(async (candidatesFiltered: string[], daWords: string[]): Promise<string> => {
  console.log("GPT is running with candidates: " + candidatesFiltered);
  console.log("GPT is running with the words: " + theWords);
  if (!candidatesFiltered || candidatesFiltered.length === 0) {
    return "";
  }
  const prompt = `
     A kid is typing a sentence very slowly. You want to guess the next word.
  
     Here are the words so far:
     ${daWords.join(", ")}
    
     Pick one word from below that is the most likely next word based on what makes sense and what is a more common word:
     {${candidatesFiltered.join(", ")}}


     Output only your guess for the next word. No quotes, no explanation.

    `.trim();
      
    console.log(prompt);
      try {
        const response = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 30,
            temperature: 0.3,
          },
          {
            headers: {
              'Authorization': 'Bearer ' + process.env.NEXT_PUBLIC_OPENAI_API_KEY,
              "Content-Type": "application/json",
            }
          }
        );
        console.log("GPT picked word: " + response.data.choices[0].message.content.trim());
        return response.data.choices[0].message.content.trim();
      } catch (error) {
        console.log("GPT didn't work for some random reason");
        return candidatesFiltered[0];
      }
    }, []);
//
// ─────────────────────────────────────────────────────────────────────────────
// G) CONSOLE LOGS FOR DEBUGGIN'
// ─────────────────────────────────────────────────────────────────────────────
/*   useEffect(() => {
  console.log("words: " + theWords.current)
}, [theWords]);

useEffect(() => {
  console.log("codes: " + theCodes.current)
}, [theCodes]);

useEffect(() => {
  console.log("code: " + code.current)
}, [code]);

useEffect(() => {
  console.log("dirty words: " + dirtyWords.current)
}, [dirtyWords]); */

useEffect(() => {
  console.log("code: " + code.current)
}, [code.current]);

// ─────────────────────────────────────────────────────────────────────────────
// H) FINALIZE THE WORD WHEN SPACE (SIDE 3) IS HIT
// ─────────────────────────────────────────────────────────────────────────────
const finalizeCurrentWord = useCallback(async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: code is non-empty
  // ──────────────────────────────────────────────────────────────────────────
  console.log("Running code analysis on " + code.current)
  
  if (code.current) {
    console.log("Our first analysis on " + code.current)
  
    // 1) Get candidates for `code` + clean dirty words
    const candidates = dictionary[code.current] || [];
    dirtyWords.current = [];
    console.log("Cleaning up dirty words: " + dirtyWords.current)

    let chosenWord;

    if (candidates.length === 1) {
      chosenWord = candidates[0];
    } else if (code.current.length === 1){
        if (dictionaryType === 'qwerty') {
          switch (code.current) {
            case "5" :
              chosenWord = 'a';
              break;
            case "8" :
              chosenWord = 'I';
              break;
          }
        }
      }
    else {
      chosenWord = await pickWordViaGPT(candidates, theWords.current);
    }

     // 3) Append the chosen word and code
    console.log("Adding the chosen word: " + chosenWord);

    theWords.current = [...theWords.current, chosenWord || ""];
    console.log("words: " + theWords.current);

    console.log("code: " + code.current);
    theCodes.current = [...theCodes.current, code.current];
    console.log("codes: " + theCodes.current);
  
    // 4) Clear current code and add word to dirty word list
    code.current = "";
    console.log("code: " + code.current);

    dirtyWords.current = [chosenWord|| ""];
    console.log("dirty words: " + dirtyWords.current);
    return;
  }
   // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: code is empty
  // ──────────────────────────────────────────────────────────────────────────
   console.log("Running swap!")
   // 1) Add latest word to dirty word list
  const lastWord = theWords.current[theWords.current.length - 1];
  console.log("last word: " + lastWord);
  dirtyWords.current = dirtyWords.current.concat(lastWord);
  console.log("dirty words: " + dirtyWords.current);
   // 2) Filter out the lastWord from candidates so we don't pick it again
  const lastCode = theCodes.current[theCodes.current.length - 1];
  console.log("last code: " + lastCode);
  const candidates = dictionary[lastCode];
  console.log("candidates: " + candidates);
  const candidatesFiltered = candidates.filter((word) => !dirtyWords.current.includes(word));

  console.log("Candidates: " + candidates);
  console.log("Candidates filtered: " + candidatesFiltered);
   // 3) Let GPT pick the best match from the filtered list
  let chosenWord = lastCode; // fallback
  if (candidates.length > 0) {
    chosenWord = await pickWordViaGPT(candidatesFiltered, theWords.current);
  }
   // 4) Replace GPT's pick with the last word on the word list!
  theWords.current = theWords.current.slice(0, -1).concat(chosenWord);

  return;
}, [code, theCodes, theWords, dictionary, pickWordViaGPT]);




//
// ─────────────────────────────────────────────────────────────────────────────
// J) POINTER LOCK SETUP
// ─────────────────────────────────────────────────────────────────────────────
useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;

  const handleClick = () => {
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock(); // Exit pointer lock if already active
    } else {
      canvas.requestPointerLock(); // Enter pointer lock if not active
    }
  };

  const lockChangeAlert = () => {
    if (document.pointerLockElement === canvas) {
      console.log("Pointer lock activated.");
      document.addEventListener("mousemove", handleMouseMove);
    } else {
      console.log("Pointer lock deactivated.");
      document.removeEventListener("mousemove", handleMouseMove);
    }
  };

  canvas.addEventListener("click", handleClick);
  document.addEventListener("pointerlockchange", lockChangeAlert);

  return () => {
    canvas.removeEventListener("click", handleClick);
    document.removeEventListener("pointerlockchange", lockChangeAlert);
  };
}, []);



// ─────────────────────────────────────────────────────────────────────────────
// K) HANDLE MOUSE MOVE
// ─────────────────────────────────────────────────────────────────────────────

const refractory = useRef<boolean>(false);
const speed = useRef<number>(1);


const handleMouseMove = useCallback((e: MouseEvent) => {

  if (!refractory.current) {
    setPosition((prev) => {

      const newX = prev.x + e.movementX * speed.current;
      const newY = prev.y + e.movementY * speed.current;

      if (newX <= 0 || newX >= 800 || newY <= 0 || newY >= 600) {
        return { x: 400, y: 300 }; // Reset position if out of bounds
      }

      return { x: newX, y: newY };
    });
  } else {
    console.log("refractory is true");
    setTimeout(() => {
      refractory.current = false;
    }, 200);
  }
}, []);


// ─────────────────────────────────────────────────────────────────────────────
// L) COLLISION CHECK => ADD CHAR OR FINALIZE IF SPACE
// ─────────────────────────────────────────────────────────────────────────────

const isDotTouchingSide = useCallback(
  (dotX: number, dotY: number, side: OctagonSide) => {
    const { startX, startY, endX, endY } = side;
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.sqrt(dx * dx + dy * dy);


    const projection = ((dotX - startX) * dx + (dotY - startY) * dy) / (length * length);
    if (projection < 0 || projection > 1) return false;


    const closestX = startX + projection * dx;
    const closestY = startY + projection * dy;
    const distance = Math.sqrt((dotX - closestX) ** 2 + (dotY - closestY) ** 2);


    return distance <= 15;
  },
  []
);

const drawScene = useCallback(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw octagon
  const centerX = 400;
  const centerY = 300;
  const radius = 200;
  const sides = 8;
  const angleStep = (2 * Math.PI) / sides;
  const rotation = Math.PI / 8;

  const newSides: OctagonSide[] = [];
  ctx.beginPath();
  let prevX: number | null = null;
  let prevY: number | null = null;

  for (let i = 0; i <= sides; i++) {
    const angle = i * angleStep - rotation;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
      if (prevX !== null && prevY !== null) {
        newSides.push({ startX: prevX, startY: prevY, endX: x, endY: y });
      }
    }
    prevX = x;
    prevY = y;
  }

  ctx.closePath();
  ctx.lineWidth = 15;
  ctx.stroke();

  // Check collisions
  newSides.forEach((side, index) => {
  const sideIndex = index + 1;
  const touching = isDotTouchingSide(position.x, position.y, side);


  if (touching) {
    new Audio('click.mp3').play().catch((error) => console.error("Error playing audio:", error));
    if (lastHitSide.current !== sideIndex) {
      const codeChar = sideMappings[sideIndex];
      // If side 3 => space => finalize
      if (codeChar === " ") {
        finalizeCurrentWord();
      } else if (codeChar === "⌫") {
        if (code.current) {
          console.log("trying to remove just the last letter");
          code.current = code.current.substring(0, code.current.length - 1);
        } else {
          theWords.current.pop();
          theCodes.current.pop();
        }
      } else if (codeChar) {
        // Add digit to typedCodes
        code.current = code.current + codeChar;
        console.log(code.current);
      }
      refractory.current = true;
      setPosition({ x: 400, y: 300 });
      //lastHitSide.current= sideIndex;
    }
    ctx.strokeStyle = "red";
  } else {
    ctx.strokeStyle = "blue";
    if (lastHitSide.current === sideIndex) {
      last;
    }
  }
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(side.startX, side.startY);
  ctx.lineTo(side.endX, side.endY);
  ctx.stroke();
});

  // Draw Labels
  ctx.font = "bold 27px Poppins";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  newSides.forEach((side, index) => {
    const sideIndex = index + 1;
    if (!sideLabels[sideIndex]) return;

    const midX = (side.startX + side.endX) / 2;
    const midY = (side.startY + side.endY) / 2;
    const dx = side.endX - side.startX;
    const dy = side.endY - side.startY;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const ndx = dy / length;
    const ndy = -dx / length;
    const offset = 40;
    const labelX = midX + offset * ndx;
    const labelY = midY + offset * ndy;

    //const isActive = lastHitSide.current === sideIndex;
    //ctx.fillStyle = lastHitSide.current === sideIndex ? "blue" : "white";
    //ctx.font = isActive ? "bold 56px Poppins, sans-serif" : "bold 27px Poppins, sans-serif";


    ctx.fillText(sideLabels[sideIndex], labelX, labelY);
  });

  // Draw Dot
  ctx.fillStyle = "gray";
  ctx.beginPath();
  ctx.arc(position.x, position.y, 18, 0, 2 * Math.PI);
  ctx.fill();

// Draw dots or last word in center of canvas
ctx.font = "69px Poppins";
ctx.fillStyle = "white";
ctx.textAlign = "center";
ctx.textBaseline = "middle";

if (code.current.length === 0) {
    // Display last word from theWords.current if it exists
    const lastWord = theWords.current[theWords.current.length - 1] || "";
    ctx.fillText(lastWord, centerX, centerY);
} else {
    // Display dots for code.current
    const dots = "*".repeat(code.current.length);
    ctx.fillText(dots, centerX, centerY);
}

  setOctagonSides(newSides);
}, [position, lastHitSide, finalizeCurrentWord, sideMappings, sideLabels, code]);

// Animate
useEffect(() => {
  const animation = requestAnimationFrame(drawScene);
  return () => cancelAnimationFrame(animation);
}, [drawScene]);


//useless edit

//
// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
return (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      justifyContent: "center", // Centers vertically
      alignItems: "center", // Centers horizontally
      height: "80vh", // Full viewport height for proper vertical centering
      backgroundColor: "black", // Optional: Sets a black background
      textAlign: "center",
      color: "white",
    }}
  >
    <div style={{ textAlign: "center", color: "white" }}>
      <div style={{ marginBottom: "10px" }}>
        <input
          type="text"
          readOnly
          value={""} // Replace with your logic to display text
          style={{
            width: "1000px",
            textAlign: "center",
            backgroundColor: "black",
            color: "white",
            padding: "5px",
            fontSize: 23,
          }}
        />
      </div>
    </div>
    <div style={{ marginBottom: "10px" }}>
       <input
         type="text"
         readOnly
         value={theWords.current.join(" ")}
         style={{
           width: "1000px",
           textAlign: "center",
           backgroundColor: "black",
           color: "white",
           padding: "5px",
           fontSize: 30
         }}
       />
     </div>
{/* Speed Slider */}
<div
  style={{
    position: "fixed", // Fixes the position relative to the viewport
    bottom: "20px",    // Distance from the bottom of the viewport
    right: "20px",     // Distance from the right of the viewport
    backgroundColor: "rgba(0, 0, 0, 0.7)", // Semi-transparent background
    padding: "10px",
    borderRadius: "8px", // Rounded corners
    color: "white",
    textAlign: "center",
  }}
>
  <label htmlFor="speed-slider" style={{ display: "block", marginBottom: "5px" }}>
    Speed: {speed.current.toFixed(1)}
  </label>
  <input
    id="speed-slider"
    type="range"
    min="0.1"
    max="2"
    step="0.1"
    value={speed.current}
    onChange={(e) => (speed.current = parseFloat(e.target.value))}
    style={{ width: "150px" }}
  />


</div>

    <div
      style={{
        position: "absolute",
        bottom: "20px",
        left: "20px",
        display: "flex",
        gap: "10px",
      }}
    >
      <button
        style={{
          backgroundColor: "transparent",
          color: "white",
          border: "1px solid white",
          borderRadius: "5px",
          padding: "5px 10px",
          fontSize: "16px",
          cursor: "pointer",
        }}
        onClick={() => setDictionaryType("abc")}
      >
        ABC
      </button>
      <button
        style={{
          backgroundColor: "transparent",
          color: "white",
          border: "1px solid white",
          borderRadius: "5px",
          padding: "5px 10px",
          fontSize: "16px",
          cursor: "pointer",
        }}
        onClick={() => setDictionaryType("qwerty")}
      >
        QWERTY
      </button>
      <button
        style={{
          backgroundColor: "transparent",
          color: "white",
          border: "1px solid white",
          borderRadius: "5px",
          padding: "5px 10px",
          fontSize: "16px",
          cursor: "pointer",
        }}
        onClick={() => setDictionaryType("optimized")}
      >
        Optimized
      </button>
    </div>

    <canvas
      ref={canvasRef}
      width={800}
      height={600}
      style={{
        border: "1px dotted black",
      }}
    />
  </div>
);
};

export default PointerLockDemo;

