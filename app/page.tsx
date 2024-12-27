"use client";
//console.log("Loaded API Key:", process.env.NEXT_PUBLIC_OPENAI_API_KEY);
//random edit


import React, { useRef, useEffect, useState, useCallback } from "react";
import axios from "axios";


require('dotenv').config()
console.log(process.env)


interface Dictionary {
 [t9Code: string]: string[];
}


interface OctagonSide {
 startX: number;
 startY: number;
 endX: number;
 endY: number;
}


const PointerLockDemo: React.FC = () => {
 //
 // ─────────────────────────────────────────────────────────────────────────────
 // A) CANVAS + POINTER LOCK STATE
 // ─────────────────────────────────────────────────────────────────────────────
 const canvasRef = useRef<HTMLCanvasElement | null>(null);
 const [position, setPosition] = useState({ x: 400, y: 300 });


 // Track collision so we don’t spam the same side
 const [lastHitSide, setLastHitSide] = useState<number | null>(null);


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
   1: "1",
   2: "2",
   3: " ",   // hitting space => finalize the word
   4: "4",
   5: "5",
   6: "6",
   7: "7",
   8: "8",
 };


 // If you want bold labels around the octagon:
 const sideLabels: Record<number, string> = {
   1: "H J K L",
   2: "B N M",
   3: "␣",
   4: "Z X C V",
   5: "A S D F",
   6: "Q W E R",
   7: "T G Y",
   8: "U I O P",
   // Skipping 3 since it's space
 };


 //
 // ─────────────────────────────────────────────────────────────────────────────
 // E) LOAD DICTIONARY ONCE
 // ─────────────────────────────────────────────────────────────────────────────
 useEffect(() => {
   fetch("/invmaps.json")
     .then((res) => res.json())
     .then((data) => setDictionary(data))
     .catch((err) => console.error("Failed to load dictionary:", err));
 }, []);


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


     // 2) If we have a valid candidate list, pick the best via GPT
     let chosenWord = await pickWordViaGPT(candidates, theWords.current);
      // 3) Append the chosen word and code
     console.log("Adding the chosen word: " + chosenWord);


     theWords.current = [...theWords.current, chosenWord];
     console.log("words: " + theWords.current);


     console.log("code: " + code.current);
     theCodes.current = [...theCodes.current, code.current];
     console.log("codes: " + theCodes.current);
    
     // 4) Clear current code and add word to dirty word list
     code.current = "";
     console.log("code: " + code.current);


     dirtyWords.current = [chosenWord];
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


   const handleClick = () => canvas.requestPointerLock();
   canvas.addEventListener("click", handleClick);


   const lockChangeAlert = () => {
     if (document.pointerLockElement === canvasRef.current) {
       document.addEventListener("mousemove", handleMouseMove);
     } else {
       document.removeEventListener("mousemove", handleMouseMove);
     }
   };
   document.addEventListener("pointerlockchange", lockChangeAlert);


   return () => {
     canvas.removeEventListener("click", handleClick);
     document.removeEventListener("pointerlockchange", lockChangeAlert);
   };
 }, []);


 //
 // ─────────────────────────────────────────────────────────────────────────────
 // K) HANDLE MOUSE MOVE
 // ─────────────────────────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: MouseEvent) => {
   setPosition((prev) => {
     const newX = prev.x + e.movementX * 0.75;
     const newY = prev.y + e.movementY * 0.75;
     if (newX <= 0 || newX >= 800 || newY <= 0 || newY >= 600) {
       return { x: 400, y: 300 };
     }
     return { x: newX, y: newY };
   });
 }, []);


 //
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
   ctx.strokeStyle = "blue";
   ctx.lineWidth = 15;
   ctx.stroke();


   // Check collisions
   newSides.forEach((side, index) => {
     const sideIndex = index + 1;
     const touching = isDotTouchingSide(position.x, position.y, side);


     if (touching) {
       if (lastHitSide !== sideIndex) {
         const codeChar = sideMappings[sideIndex];
         // If side 3 => space => finalize
         if (codeChar === " ") {
           finalizeCurrentWord();
         } else if (codeChar) {
           // Add digit to typedCodes
           code.current = code.current + codeChar;
           console.log(code.current);
         }
         setPosition({ x: 400, y: 300 });
         setLastHitSide(sideIndex);
       }
       ctx.strokeStyle = "red";
     } else {
       ctx.strokeStyle = "blue";
       if (lastHitSide === sideIndex) {
         setLastHitSide(null);
       }
     }


     ctx.lineWidth = 15;
     ctx.beginPath();
     ctx.moveTo(side.startX, side.startY);
     ctx.lineTo(side.endX, side.endY);
     ctx.stroke();
   });


   // Labels (optional)
   ctx.font = "bold 24px Arial";
   ctx.fillStyle = "white";
   ctx.textAlign = "center";
   ctx.textBaseline = "middle";


   newSides.forEach((side, index) => {
     const sideIndex = index + 1;
     if (!sideLabels[sideIndex]) return;


     // midpoint
     const midX = (side.startX + side.endX) / 2;
     const midY = (side.startY + side.endY) / 2;
     // shift outward
     const dx = side.endX - side.startX;
     const dy = side.endY - side.startY;
     const length = Math.sqrt(dx * dx + dy * dy) || 1;
     const ndx = dy / length;
     const ndy = -dx / length;
     const offset = 40;
     const labelX = midX + offset * ndx;
     const labelY = midY + offset * ndy;


     ctx.fillText(sideLabels[sideIndex], labelX, labelY);
   });


   // Dot
   ctx.fillStyle = "red";
   ctx.beginPath();
   ctx.arc(position.x, position.y, 5, 0, 2 * Math.PI);
   ctx.fill();


   setOctagonSides(newSides);
 }, [
   position,
   lastHitSide,
   finalizeCurrentWord,
   sideMappings,
   sideLabels,
   isDotTouchingSide,
   code,
   setPosition,
 ]);


 // Animate
 useEffect(() => {
   const animation = requestAnimationFrame(drawScene);
   return () => cancelAnimationFrame(animation);
 }, [drawScene]);


 //
 // ─────────────────────────────────────────────────────────────────────────────
 // RENDER
 // ─────────────────────────────────────────────────────────────────────────────
 return (
   <div style={{ textAlign: "center", color: "white" }}>


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
           fontSize: 56
         }}
       />
     </div>


     <canvas
       ref={canvasRef}
       width={800}
       height={600}
       style={{border: "1px solid white" }}
     />
   </div>
 );
};


export default PointerLockDemo;