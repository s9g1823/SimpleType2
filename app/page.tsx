"use client";

import React, {
  useRef,
  useEffect,
  useState,
  Suspense,
  useCallback,
} from "react";
import axios from "axios";
import { useSearchParams } from "next/navigation";

import VelocityZmqListener, { DecodePacket } from "./ZmqListener";
import ZmqSubscribeClient from "./ZmqSubscribeClient";

import { Tree, WordFrequency, getRankedMatches } from "./words";

interface Dictionary {
  [t9Code: string]: string[];
}

interface OctagonSide {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

enum DirectionalRendering {
  CenterOutGradient = "Center Out",
  CenterInGradient = "Center In",
  TrapezoidTile = "Trapezoid",
}

import "@fontsource/poppins"; // Defaults to weight 400

const PointerLockWrapper: React.FC = () => {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PointerLockDemo />
    </Suspense>
  );
};

const PointerLockDemo: React.FC = () => {
  // System cursor configuration: by default do not use it, but override if the
  // environment variable or url parameter is set.
  const searchParams = useSearchParams();
  const urlSystemCursor =
    searchParams.get("systemCursor")?.toLowerCase() === "true";
  require("dotenv").config();
  const envSystemCursor = process.env.NEXT_PUBLIC_USE_SYSTEM_CURSOR === "1";
  const systemCursorEnabled = urlSystemCursor || envSystemCursor;

  //ZMQ setup for Link
  const zmqService = useRef(VelocityZmqListener.factory());
  const velocities = useRef<DecodePacket | null>(null);
  const sideLikelihoods = useRef<number[]>(Array(8).fill(0));

  const directionalMode = useRef<boolean>(false);
  // const directionalRendering = useRef<DirectionalRendering>(DirectionalRendering.CenterOutGradient);
  const directionalRendering = useRef<DirectionalRendering>(
    DirectionalRendering.TrapezoidTile,
  );

  useEffect(() => {
    zmqService.current.start();

    return () => {
      zmqService.current.stop();
    };
  }, []);

  useEffect(() => {
    function handleDecodeData(data: DecodePacket) {
      velocities.current = data;
      //console.log('Received velocity data:', data);

      // Map hacked click values to the corresponding sides
      // Numbering goes clockwise starting from space
      sideLikelihoods.current[0] =
        velocities.current.left_click_probability_smoothed;
      sideLikelihoods.current[1] = velocities.current.velocity_smoothed_x;
      sideLikelihoods.current[2] =
        velocities.current.raw_left_click_probability;
      sideLikelihoods.current[3] = velocities.current.velocity_smoothed_y;
      sideLikelihoods.current[4] =
        velocities.current.middle_click_probability_smoothed;
      sideLikelihoods.current[5] =
        velocities.current.raw_middle_click_probability;
      sideLikelihoods.current[6] =
        velocities.current.right_click_probability_smoothed;
      sideLikelihoods.current[7] =
        velocities.current.raw_right_click_probability;

      if (!refractory.current) {
        const newX =
          position.current.x +
          velocities.current.final_velocity_x * speed.current * 0.01;
        const newY =
          position.current.y +
          velocities.current.final_velocity_y * speed.current * 0.01;

        // For testing
        // for (let i = 0; i <= 8; i++) {
        //     sideLikelihoods.current[i] = i * (1 / 8);
        // }

        if (!directionalMode.current) {
          position.current = { x: newX, y: newY };
        }
      } else {
        setTimeout(() => {
          refractory.current = false;
        }, 150);
      }
    }

    zmqService.current.events.on(
      ZmqSubscribeClient.EVENT_MESSAGE,
      handleDecodeData,
    );

    return () => {
      zmqService.current.events.off(
        ZmqSubscribeClient.EVENT_MESSAGE,
        handleDecodeData,
      );
    };
  }, [velocities.current]);

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // A) CANVAS + POINTER LOCK STATE
  // ─────────────────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const position = useRef({ x: 800, y: 480 });

  // Track collision so we don’t spam the same side
  const lastHitSide = useRef<number | null>();

  // The lines making up the octagon, if needed for reference
  const [octagonSides, setOctagonSides] = useState<OctagonSide[]>([]);

  const [isLocked, setIsLocked] = useState(false);
  const togglePointerLock = useCallback(() => {
    if (!isLocked) {
      canvasRef.current?.requestPointerLock();
    } else {
      document.exitPointerLock();
    }
    setIsLocked(!isLocked);
  }, [isLocked]);

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

  // List of possible words that can be resolved at any moment, sorted by
  // likelihood of occuring.
  const possibleWords = useRef<string[]>([]);
  const bestWord = useRef<string>("");

  const dirtyWords = useRef<string[]>([]);

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // D) SIDE MAPPINGS
  // ─────────────────────────────────────────────────────────────────────────────
  // If side 3 => space => finalize the current code.

  const sideMappings: Record<number, string> = {
    1: " ",
    2: "2",
    3: "3",
    4: "4",
    5: "⌫",
    6: "6",
    7: "7",
    8: "8",
  };

  // If you want bold labels around the octagon:
  const getSideLabels = (type: string): Record<number, string> => {
    switch (type) {
      case "abc":
        return {
          1: "␣",
          2: "W X Y Z",
          3: "S T U V",
          4: "N O P Q R",
          5: "⌫",
          6: "A B C D E",
          7: "F G H I",
          8: "J K L M",
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

  const [dictionaryType, setDictionaryType] = useState("abc");

  const sideLabels = getSideLabels(dictionaryType);

  const codeTree = useRef<Record<string, unknown>>({});
  const wordFreq = useRef<Record<string, number>>({});
  const trigrams = useRef<Record<string, number>>({});
  const precomputedTrees = useRef<Record<string, any>>({});
  const dataReady = useRef<boolean>(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [codeTreeData, trigramData, wordFreqData, precomputedData] =
          await Promise.all([
            fetch("/code_tree.json").then((res) => res.json()),
            fetch("/trigram_model.json").then((res) => res.json()),
            fetch("/word_freq.json").then((res) => res.json()),
            fetch("/precomputed.json").then((res) => res.json()),
          ]);

        codeTree.current = codeTreeData;
        trigrams.current = trigramData;
        wordFreq.current = wordFreqData;
        precomputedTrees.current = precomputedData;
        dataReady.current = true;

        console.log("All data loaded and precomputed.");
      } catch (err) {
        console.error("Failed to load data:", err);
      }
    };

    fetchData();
  }, []);

  //
  // ───────────────────────────────────────────"─────────────────────────────────
  // E.2) CURRENT CODE -> WORDS LOOKUP
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    console.time("getRankedMatches Execution Time");

    // Don't eval on empty current code.
    console.log("CODE LEN IS: ", code.current.length);
    if (code.current.length === 0) {
      return;
    }

    Promise.resolve().then(() => {
      possibleWords.current = getRankedMatches(
        theWords.current,
        code.current,
        codeTree.current,
        trigrams.current,
        wordFreq.current,
        precomputedTrees.current,
      );

      console.log("Ranked: ", possibleWords.current);
      console.timeEnd("getRankedMatches Execution Time");
    });
  }, [code.current]);

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // F) GPT LOOKUP
  // ─────────────────────────────────────────────────────────────────────────────

  const pickWordViaGPT = useCallback(
    async (
      candidatesFiltered: string[],
      daWords: string[],
    ): Promise<string> => {
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
              Authorization: "Bearer " + process.env.NEXT_PUBLIC_OPENAI_API_KEY,
              "Content-Type": "application/json",
            },
          },
        );
        console.log(
          "GPT picked word: " + response.data.choices[0].message.content.trim(),
        );
        return response.data.choices[0].message.content.trim();
      } catch (error) {
        console.log("GPT didn't work for some random reason");
        return candidatesFiltered[0];
      }
    },
    [],
  );
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
    console.log("code: " + code.current);
  }, [code.current]);

  // ─────────────────────────────────────────────────────────────────────────────
  // H) FINALIZE THE WORD WHEN SPACE (SIDE 3) IS HIT
  // ─────────────────────────────────────────────────────────────────────────────
  //Hitting "ZZ " => will turn gravity on 0.4 of radius
  //Then clicking "60%" button will make it 60% of radius
  //Then moving slider will also be able to adjust accordingly
  //Closin button will make it go 2% closer each hit

  const radiusOct = 350;

  const gravity = useRef<number>(18);
  const gravityClosin = useRef<boolean>(false);

  const finalizeCurrentWord = useCallback(async () => {
    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: code is non-empty
    // ──────────────────────────────────────────────────────────────────────────
    console.log("Running code analysis on " + code.current);

    if (code.current) {
      console.log("Our first analysis on " + code.current);

      // 1) Get candidates for `code` + clean dirty words
      dirtyWords.current = [];
      const candidates = [...possibleWords.current];
      console.log("Cleaning up dirty words: " + dirtyWords.current);

      let chosenWord;

      if (candidates.length === 1 && candidates[0] != "u") {
        chosenWord = candidates[0];

        // Shortcut commands
      } else if (
        code.current.length === 1 ||
        code.current == "22" ||
        code.current == "88" ||
        code.current == "222"
      ) {
        if (dictionaryType === "abc") {
          switch (code.current) {
            case "6":
              chosenWord = "a";
              break;
            case "2":
              speed.current = speed.current - 0.3;
              console.log("speed " + speed.current);
              break;
            case "3":
              speed.current = speed.current + 0.3;
              console.log("speed " + speed.current);
              break;
            case "4":
              new Audio("on2.mp3")
                .play()
                .catch((error) => console.error("Error playing audio:", error));
              break;
            case "7":
              chosenWord = "I";
              break;
            case "8":
              console.log("runs");
              theCodes.current = [];
              theWords.current = [];
              console.log("Resetting code");
              code.current = "";

              inLights.current = true;
              indexRefCode.current = 0;
              indexSentence.current = 0;

              let rng = Math.floor(Math.random() * arrays.length);

              refCode.current = arrays[rng];
              sentence.current = sentences[rng];

              //calculations
              goodHits.current = 0;
              badHits.current = 0;

              timerStart.current = performance.now();

              break;
            case "22":
              gravity.current = 0.4 * radiusOct;
              break;

            // Clear all
            case "88":
              theWords.current = [];
              break;

            // Copy to clipboard
            case "222":
              try {
                await navigator.clipboard.writeText(theWords.current.join(" "));
              } catch (err) {
                console.error("Clipboard not supported!");
              }
              break;
          }
        }
      } else {
        // chosenWord = await pickWordViaGPT(candidates, theWords.current);
        console.log("Chose candidate");
        chosenWord = candidates[0];
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

      dirtyWords.current = [chosenWord || ""];
      console.log("dirty words: " + dirtyWords.current);
      return;
    }
    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: code is empty
    // ──────────────────────────────────────────────────────────────────────────
    console.log("Running swap!");

    // 1) Add latest word to dirty word list
    const lastWord = theWords.current[theWords.current.length - 1];
    console.log("last word: " + lastWord);
    dirtyWords.current = dirtyWords.current.concat(lastWord);
    console.log("dirty words: " + dirtyWords.current);

    // 2) Filter out the lastWord from candidates so we don't pick it again
    const lastCode = theCodes.current[theCodes.current.length - 1];
    console.log("last code: " + lastCode);
    const candidates = [...possibleWords.current];
    console.log("candidates: " + candidates);
    const candidatesFiltered = candidates.filter(
      (word) => !dirtyWords.current.includes(word),
    );

    console.log("Candidates: " + candidates);
    console.log("Candidates filtered: " + candidatesFiltered);

    // 3) Let GPT pick the best match from the filtered list
    let chosenWord = lastCode; // fallback
    if (candidates.length > 0) {
      chosenWord = candidatesFiltered[0];
    }
    // 4) Replace GPT's pick with the last word on the word list!
    theWords.current = theWords.current.slice(0, -1).concat(chosenWord);

    return;
  }, [code, theCodes, theWords, pickWordViaGPT]);

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // J) POINTER LOCK SETUP
  // ─────────────────────────────────────────────────────────────────────────────

  //Game mode 2.0: no words in the center OR asterisks. No word prediction calls.
  //So basically, we just keep code.current always empty and never call finalizeCurrentWord().
  // So no word prediction stuff gets triggered.

  const inLights = useRef<boolean>(false);

  const refCode = useRef<number[]>();
  const indexRefCode = useRef<number>();

  const sentence = useRef<string[]>();
  const indexSentence = useRef<number>();

  const goodHits = useRef<number>();
  const badHits = useRef<number>();

  const timerStart = useRef<number>(); //timer
  const timerEnd = useRef<number>();
  const timeLength = useRef<number>();

  const accuracy = useRef<number>();
  const ccpm = useRef<number>();

  const hitTimes = useRef<number[]>([]); //times for each hit that you do (analysis purposes)
  const hitTimerStart = useRef<number>();
  const hitTimerEnd = useRef<number>();
  const hitTimeLength = useRef<number>();

  const arrays = [
    [
      3, 7, 6, 1, 4, 3, 7, 6, 8, 1, 6, 4, 4, 2, 4, 1, 7, 4, 2, 1, 8, 3, 8, 4, 3,
      1, 4, 3, 6, 4, 1, 3, 7, 6, 1, 8, 6, 2, 2, 1, 6, 4, 7, 1,
    ],
    [
      6, 4, 8, 7, 4, 6, 3, 6, 1, 3, 7, 6, 1, 3, 4, 3, 6, 8, 1, 3, 3, 4, 4, 1, 6,
      4, 4, 7, 7, 6, 6, 4, 6, 6, 1,
    ],
    [
      7, 3, 1, 2, 6, 3, 1, 6, 6, 4, 8, 2, 1, 7, 4, 1, 3, 7, 6, 1, 8, 4, 4, 4, 7,
      4, 7, 1, 2, 7, 6, 4, 1, 7, 6, 1, 4, 4, 6, 6, 1, 7, 4, 3, 4, 1, 3, 7, 6, 1,
      3, 4, 2, 4, 1,
    ],
    [
      7, 6, 1, 6, 6, 8, 6, 1, 4, 7, 6, 7, 4, 7, 1, 7, 4, 4, 8, 1, 3, 7, 6, 1, 3,
      4, 3, 3, 7, 1, 3, 7, 6, 6, 1, 3, 8, 4, 2, 8, 2, 1, 8, 4, 4, 8, 7, 4, 7, 1,
      6, 8, 8, 1, 6, 4, 4, 3, 4, 6, 1,
    ],
    [
      2, 4, 3, 4, 6, 1, 4, 4, 3, 1, 6, 1, 3, 7, 8, 6, 1, 6, 8, 4, 6, 8, 1, 2, 4,
      3, 4, 6, 1, 6, 1, 3, 7, 8, 6, 1, 6, 4, 8, 6, 1,
    ],
    [
      6, 8, 8, 1, 2, 6, 1, 6, 4, 6, 1, 7, 3, 1, 6, 4, 1, 7, 3, 8, 6, 1, 4, 7, 1,
      7, 8, 7, 7, 7, 3, 8, 6, 3, 3, 1, 6, 7, 4, 6, 3, 1,
    ],
    [
      7, 1, 6, 4, 4, 3, 1, 2, 6, 4, 4, 6, 1, 6, 6, 1, 3, 7, 6, 1, 6, 8, 6, 8, 6,
      1, 4, 4, 3, 1, 6, 4, 2, 8, 4, 4, 6, 1,
    ],
  ];

  const sentences = [
    ["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"],
    ["dominate", "the", "truck", "stop", "confidence"],
    [
      "It",
      "was",
      "early",
      "in",
      "the",
      "morning",
      "when",
      "he",
      "rode",
      "into",
      "the",
      "town",
    ],
    [
      "He",
      "came",
      "riding",
      "from",
      "the",
      "south",
      "side",
      "slowly",
      "looking",
      "all",
      "around",
    ],
    ["youre", "not", "a", "time", "clock", "youre", "a", "time", "bomb"],
    ["all", "we", "are", "is", "an", "isle", "of", "flightless", "birds"],
    ["i", "dont", "wanna", "be", "the", "blame", "not", "anymore"],
  ];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (systemCursorEnabled) {
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

      if (!velocities) {
        document.addEventListener("mousemove", handleMouseMove);
      }

      canvas.addEventListener("click", handleClick);
      document.addEventListener("pointerlockchange", lockChangeAlert);

      return () => {
        canvas.removeEventListener("click", handleClick);
        document.removeEventListener("pointerlockchange", lockChangeAlert);
      };
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // K) HANDLE MOUSE MOVE
  // ─────────────────────────────────────────────────────────────────────────────

  const refractory = useRef<boolean>(false);
  const speed = useRef<number>(1);
  const activeSide = useRef<number | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // console.log("running handleMouseMove()");
    if (systemCursorEnabled) {
      if (!refractory.current) {
        if (!velocities.current) {
          // console.log("good");
          const newX = position.current.x + e.movementX * speed.current;
          const newY = position.current.y + e.movementY * speed.current;
          // console.log(newX);
          position.current = { x: newX, y: newY };
        } else {
          console.log(
            "WE ARE GETTING IT" + velocities.current.final_velocity_x,
          );

          const newX =
            position.current.x +
            velocities.current.final_velocity_x * speed.current * 0.01;
          const newY =
            position.current.y +
            velocities.current.final_velocity_y * speed.current * 0.01;
          return { x: newX, y: newY };
        }
      } else {
        setTimeout(() => {
          refractory.current = false;
        }, 100);
      }
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // L) COLLISION CHECK => ADD CHAR OR FINALIZE IF SPACE
  // ─────────────────────────────────────────────────────────────────────────────

  //
  const isDotOutsideSide = useCallback(
    (dotX: number, dotY: number, side: OctagonSide) => {
      const { startX, startY, endX, endY } = side;

      // Vector of the side
      const dx = endX - startX;
      const dy = endY - startY;

      // Normalize the vector
      const length = Math.sqrt(dx * dx + dy * dy);
      const unitDx = dx / length;
      const unitDy = dy / length;

      // Calculate normal pointing outward (right of the direction vector)
      const normalX = unitDy; // Normal points outward
      const normalY = -unitDx; // Normal points outward

      // Vector from start point to dot
      const dotVectorX = dotX - startX;
      const dotVectorY = dotY - startY;

      // Dot product with the normal
      const dotProduct = dotVectorX * normalX + dotVectorY * normalY;

      return dotProduct > 0; // Greater than 0 means outside
    },
    [],
  );

  const isDotTouchingSide = useCallback(
    (dotX: number, dotY: number, side: OctagonSide) => {
      const { startX, startY, endX, endY } = side;
      const dx = endX - startX;
      const dy = endY - startY;
      const length = Math.sqrt(dx * dx + dy * dy);

      const projection =
        ((dotX - startX) * dx + (dotY - startY) * dy) / (length * length);
      if (projection < 0 || projection > 1) return false;

      const closestX = startX + projection * dx;
      const closestY = startY + projection * dy;
      const distance = Math.sqrt(
        (dotX - closestX) ** 2 + (dotY - closestY) ** 2,
      );

      return distance <= gravity.current;
    },
    [],
  );

  const predictedWord = useRef<String>();

  function predictTheWord() {
    code.current;
  }

  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw octagon
    const centerX = 800;
    const centerY = 480;

    const radius = radiusOct;
    // const innerRadius = (radius / 1.618); // Golden ratio lol
    // const radius = 450;
    const innerRadius =
      directionalRendering.current === DirectionalRendering.TrapezoidTile
        ? radius / 1.618
        : 0; // Golden ratio lol

    const sides = 8;
    const angleStep = (2 * Math.PI) / sides;
    const rotation = Math.PI / 8;

    // Anchors for suggestion words
    const suggestionsY = centerY + canvas.height / 2 / 5;

    const newSides: OctagonSide[] = [];

    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const angle = i * angleStep - rotation;
      const prevAngle = (i - 1) * angleStep - rotation;

      const angCos = Math.cos(angle);
      const angSin = Math.sin(angle);
      const innerAngCos = Math.cos(prevAngle);
      const innerAngSin = Math.sin(prevAngle);

      const vertexX = centerX + radius * angCos;
      const vertexY = centerY + radius * angSin;
      let prevX = centerX + radius * innerAngCos;
      let prevY = centerY + radius * innerAngSin;

      const vertexInnerX = centerX + innerRadius * angCos;
      const vertexInnerY = centerY + innerRadius * angSin;
      let prevInnerX = centerX + innerRadius * innerAngCos;
      let prevInnerY = centerY + innerRadius * innerAngSin;

      const deltaX = vertexX - prevX!;
      const deltaY = vertexY - prevY!;
      const startOffsetX = prevX! + deltaX * 0.0;
      const startOffsetY = prevY! + deltaY * 0.0;
      const endOffsetX = prevX! + deltaX * 1;
      const endOffsetY = prevY! + deltaY * 1;

      if (i === 0) {
        ctx.moveTo(vertexX, vertexY);
      } else {
        // Draw shortened side
        ctx.moveTo(startOffsetX, startOffsetY);
        ctx.lineTo(endOffsetX, endOffsetY);

        // Store the shortened side for collision detection
        newSides.push({
          startX: startOffsetX,
          startY: startOffsetY,
          endX: endOffsetX,
          endY: endOffsetY,
        });

        if (directionalMode.current) {
          const delta2X = vertexInnerX - prevInnerX!;
          const delta2Y = vertexInnerY - prevInnerY!;
          const innerOffsetStartX = prevInnerX! + delta2X * 0;
          const innerOffsetStartY = prevInnerY! + delta2Y * 0;

          const innerOffsetEndX = prevInnerX! + delta2X * 1;
          const innerOffsetEndY = prevInnerY! + delta2Y * 1;

          const gradient = ctx.createLinearGradient(
            (innerOffsetStartX + innerOffsetEndX) / 2,
            (innerOffsetStartY + innerOffsetEndY) / 2,
            (startOffsetX + endOffsetX) / 2,
            (startOffsetY + endOffsetY) / 2,
          );

          const alpha = sideLikelihoods.current[i - 1] * 0.65;

          let style: CanvasGradient | string | undefined;
          switch (directionalRendering.current) {
            // Outward bar mode
            case DirectionalRendering.CenterOutGradient:
              gradient.addColorStop(0, "green");
              gradient.addColorStop(sideLikelihoods.current[i - 1], "black");
              style = gradient;
              break;
            // Gradient towards center
            case DirectionalRendering.CenterInGradient:
              gradient.addColorStop(
                1 - sideLikelihoods.current[i - 1],
                "black",
              );
              gradient.addColorStop(1, "green");
              style = gradient;
              break;
            case DirectionalRendering.TrapezoidTile:
              style = `rgba(0, 255, 0, ${alpha})`;
              break;
          }

          // directionalRendering.current = DirectionalRendering.TrapezoidTile;

          // Draw trapezoid
          ctx.beginPath();
          ctx.moveTo(startOffsetX, startOffsetY);
          ctx.lineTo(endOffsetX, endOffsetY);
          ctx.lineTo(innerOffsetEndX, innerOffsetEndY);
          ctx.lineTo(innerOffsetStartX, innerOffsetStartY);
          ctx.closePath();

          ctx.fillStyle = style;
          ctx.fill();
        }
      }
    }

    // Complete the octagon shape
    ctx.closePath();

    ctx.fillStyle = "white";

    // Check collisions
    newSides.forEach((side, index) => {
      const sideIndex = index + 1;
      let touching =
        isDotTouchingSide(position.current.x, position.current.y, side) ||
        isDotOutsideSide(position.current.x, position.current.y, side);

      if (directionalMode.current && !refractory.current) {
        touching = sideLikelihoods.current[index] === 1;
      }

      console.log("PROB: ", sideLikelihoods.current[3]);

      if (touching) {
        if (timeLength.current !== undefined) {
          timeLength.current = undefined;
          timerEnd.current = undefined;
          timerStart.current = undefined;
          goodHits.current = undefined;
          badHits.current = undefined;
          hitTimes.current = [];
          hitTimeLength.current = undefined;
          hitTimerEnd.current = undefined;
          hitTimerStart.current = undefined;
        }

        if (
          refCode.current &&
          indexRefCode.current !== undefined &&
          sideIndex !== refCode.current[indexRefCode.current]
        ) {
          new Audio("erro.mp3")
            .play()
            .catch((error) => console.error("Error playing audio:", error));
          badHits.current = (badHits.current ?? 0) + 1;
        } else {
          new Audio("click.mp3")
            .play()
            .catch((error) => console.error("Error playing audio:", error));
          goodHits.current = (goodHits.current ?? 0) + 1;
        }

        //New gravity threshold every time you hit a side (if in gravity random mode)
        if (gravityClosin.current) {
          gravity.current += radiusOct * 0.01;
        }

        if (
          indexRefCode.current === undefined ||
          (refCode.current &&
            indexRefCode.current !== undefined &&
            sideIndex === refCode.current[indexRefCode.current])
        ) {
          if (indexRefCode.current !== undefined) {
            indexRefCode.current += 1;
            hitTimes.current?.push(
              Math.round(performance.now() - (hitTimerStart.current ?? 0)),
            );
            console.log("hitting: " + hitTimes.current);
            hitTimerStart.current = performance.now();
          }
          const codeChar = sideMappings[sideIndex];
          // If side 3 => space => finalize
          if (codeChar === " ") {
            if (
              refCode.current !== undefined &&
              sentence.current !== undefined &&
              indexSentence.current !== undefined
            ) {
              theWords.current = [
                ...theWords.current,
                sentence.current[indexSentence.current] || "",
              ];
              indexSentence.current += 1;
              code.current = "";
              if (indexSentence.current === sentence.current.length) {
                timerEnd.current = performance.now();
                timeLength.current =
                  timerEnd.current - (timerStart.current ?? 0);
                inLights.current = false;
                refCode.current = undefined;
                indexRefCode.current = undefined;
                sentence.current = undefined;
                indexSentence.current = undefined;
              }
            } else if (!inLights.current) {
              finalizeCurrentWord();
            }
          } else if (codeChar === "⌫") {
            if (code.current) {
              console.log("trying to remove just the last letter");
              code.current = code.current.substring(0, code.current.length - 1);
            } else {
              theWords.current.pop();
              theCodes.current.pop();
            }
          } else if (codeChar && !inLights.current) {
            // Add digit to typedCodes
            code.current = code.current + codeChar;
            console.log(code.current);
          }
          //lastHitSide.current= sideIndex;
        }
        refractory.current = true;
        position.current = { x: 800, y: 480 };
        activeSide.current = sideIndex;
        setTimeout(() => {
          activeSide.current = null;
        }, 50);
      } else if (
        refCode.current &&
        indexRefCode.current !== undefined &&
        refCode.current[indexRefCode.current] == sideIndex
      ) {
        //when not touching and in Game mode
        ctx.strokeStyle = "yellow";
      } else {
        if (activeSide.current === sideIndex) {
          ctx.strokeStyle = "white";
        } else {
          ctx.strokeStyle = "rgba(0, 124, 56)"; // Blue with 30% opacity
        }
      }
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(side.startX, side.startY);
      ctx.lineTo(side.endX, side.endY);
      ctx.stroke();
    });

    // Draw Labels
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "white";

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

      // Different offsets for cardinal and angled sides
      const offset = [2, 4, 6, 8].includes(sideIndex) ? 120 : 35; // Cardinal: 70px, Angled: 50px
      const labelX = midX + offset * ndx;
      const labelY = midY + offset * ndy;

      ctx.font =
        activeSide.current === sideIndex
          ? "bold 69px Poppins, sans-serif"
          : "bold 50px Poppins, sans-serif";

      ctx.fillStyle = "white";

      if (
        refCode.current &&
        indexRefCode.current !== undefined &&
        refCode.current[indexRefCode.current] == sideIndex
      ) {
        ctx.fillStyle = "yellow";
      }

      ctx.fillText(sideLabels[sideIndex], labelX, labelY);
    });

    // Draw Dot

    if (!dataReady.current) {
      ctx.fillStyle = "orange";
    } else {
      ctx.fillStyle = "lightgray";
    }
    ctx.beginPath();

    const cursorSize = directionalMode.current ? 0 : 11;
    ctx.arc(position.current.x, position.current.y, cursorSize, 0, 2 * Math.PI);
    ctx.fill();

    // Using monospace font because it is easier to render– sorry Sehej BRUH
    ctx.font = "80px Monaco";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (code.current.length === 0 && !inLights.current) {
      // Display last word from theWords.current if it exists
      const lastWord = theWords.current[theWords.current.length - 1] || "";
      ctx.fillText(lastWord, centerX, centerY);

      // Only display suggestions when we are also displaying a current word.
      if (lastWord !== "") {
        // Draw suggestions on screen
        ctx.font = "30px Monaco";
        ctx.fillStyle = "grey";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        let cur_index = possibleWords.current.indexOf(lastWord);

        let currentY = suggestionsY;
        // Show 3 suggestions max
        let suggestions = possibleWords.current.slice(
          Math.min(cur_index + 1, possibleWords.current.length),
        );
        for (let i = 0; i < Math.min(suggestions.length, 3); i++) {
          ctx.fillText(suggestions[i], centerX, currentY);
          currentY += 35;
        }
      }
    } else {
      // For now, only do partial styling of the word with suggestions when
      // there is at least 2 characters due to the hardcoding of the shortcuts
      if (possibleWords.current.length > 0) {
        const bestWord = possibleWords.current[0];
        const place = code.current.length;

        const totalWidth = ctx.measureText(bestWord).width;
        let currentX = centerX - totalWidth / 2;
        for (let i = 0; i < bestWord.length; i++) {
          const char = bestWord[i];

          // Color the known part of the word with standard styling
          if (i < place) {
            ctx.fillStyle = "white";
            // Use a gray styling for anything that remains.
          } else {
            // For now, only do partial styling of the word with suggestions when
            // there is at least 2 characters due to the hardcoding of the shortcuts
            if (code.current.length < 2) {
              break;
            }
            ctx.fillStyle = "gray";
          }

          ctx.fillText(char, currentX, centerY);
          currentX += ctx.measureText(char).width;
        }

        if (code.current.length > 1) {
          // Draw suggestions on screen
          ctx.font = "30px Monaco";
          ctx.fillStyle = "grey";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          let currentY = suggestionsY;
          // Show 3 suggestions max
          for (let i = 0; i < Math.min(possibleWords.current.length, 3); i++) {
            ctx.fillText(possibleWords.current[i], centerX, currentY);
            currentY += 35;
          }
        }
      }
    }

    ctx.font = "32px Poppins"; // Smaller font size
    ctx.fillStyle = "#CACACA"; // Faded white color
    if (!inLights.current) {
      ctx.fillText(theWords.current.join(" "), centerX, centerY - 200); // Adjust Y-coordinate to place it above
    }

    //Draw calculations for Game Mode
    if (timerEnd.current !== undefined) {
      ctx.font = "69px Poppins";
      ctx.fillStyle = "lightgreen"; // Set the text color
      ctx.textAlign = "center"; // Align the text to the left
      ctx.fillText(
        `${((((goodHits.current ?? 0) - 1) / (timeLength.current ?? 1)) * 60000).toFixed(2)} CCPM`,
        centerX,
        centerY + 200,
      );

      // Calculate accuracy percentage
      const totalHits = (goodHits.current ?? 0) + (badHits.current ?? 0);
      const accuracy =
        totalHits > 0 ? ((goodHits.current ?? 0) / totalHits) * 100 : 0;

      // Format timerLength.current as MM:SS
      const timeInSeconds = Math.floor((timeLength.current ?? 0) / 1000);
      const timerSeconds = timeInSeconds % 60;
      const timerMinutes = Math.floor(timeInSeconds / 60);
      const formattedTime = `${timerMinutes.toString().padStart(2, "0")}:${timerSeconds
        .toString()
        .padStart(2, "0")}`;

      // Display smaller, centered text
      ctx.font = "32px Poppins"; // Smaller font size
      ctx.fillStyle = "white"; // Text color
      ctx.fillText(
        `${accuracy.toFixed(2)}% | ${formattedTime}`,
        centerX,
        centerY + 270,
      );

      ctx.font = "11px Poppins"; // Smaller font size
      ctx.fillText(`${hitTimes.current}`, centerX, centerY - 40);
    }

    setOctagonSides(newSides);
  }, [
    position,
    sideLikelihoods,
    lastHitSide,
    finalizeCurrentWord,
    sideMappings,
    sideLabels,
    code,
  ]);

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
      <div
        style={{
          position: "fixed",
          top: "10px",
          left: "10px",
        }}
      >
      {/* Top-left button */}
      <button
        style={{
          // position: "fixed",
          // top: "10px",
          // left: "10px",
          padding: "15px 25px",
          fontSize: "18px",
          color: "white",
          border: "1px solid white", // Thin white border
          borderRadius: "8px",
          cursor: "pointer",
          boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)",
          transition: "background-color 0.3s ease, box-shadow 0.3s ease",
        }}
        onClick={(e) => {
          const button = e.currentTarget as HTMLElement;
          button.style.backgroundColor = "lightblue";
          setTimeout(() => {
            button.style.backgroundColor = "black";
          }, 150);

          const audio = new Audio("off3.mp3"); // Replace with the path to your MP3 file
          audio.play();
        }}
      >
        🗣️ Cursor Off
      </button>

      {/* Copy to clipboard button */}
      <button
        style={{
          position: "relative",
          // left: "100%",
          // top: "120px",
          // left: "10px",
          padding: "15px 25px",
          fontSize: "18px",
          color: "white",
          border: "1px solid white", // Thin white border
          borderRadius: "8px",
          cursor: "pointer",
          boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)",
          transition: "background-color 0.3s ease, box-shadow 0.3s ease",
        }}
        onClick={(e) => {
          const button = e.currentTarget as HTMLElement;
          button.style.backgroundColor = "lightblue";
          setTimeout(() => {
            button.style.backgroundColor = "black";
          }, 150);

          try {
            navigator.clipboard.writeText(theWords.current.join(" "));
          } catch (err) {
            console.error("Clipboard not supported!");
          }
        }}
      >
        📋 Copy to clipboard
      </button>
      </div>

      <label
        style={{
          position: "fixed",
          bottom: 0,
          left: "25%",
          padding: "15px 25px",
          fontSize: "15px",
          color: "lightgray",
          fontFamily: "Monaco, monospace",
        }}
      >
        SHORTCUTS: [ Clear: JJ␣ ] [Cursor On: N␣ ]
      </label>

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
            fontSize: 30,
          }}
        />
      </div>

      {/* Render mode options */}
      <div
        style={{ position: "fixed", bottom: 0, left: 0, padding: "5px 10px" }}
      >
        <button
          onClick={() => {
            directionalMode.current = !directionalMode.current;
          }}
          style={{
            backgroundColor: "#555555", // Off-black button background
            color: "white", // White text
            border: "none",
            borderRadius: "5px",
            padding: "5px 15px",
            cursor: "pointer",
          }}
        >
          Direction Mode: {directionalMode.current ? "True" : "False"}
        </button>

        <button
          onClick={() => {
            switch (directionalRendering.current) {
              case DirectionalRendering.CenterInGradient:
                directionalRendering.current =
                  DirectionalRendering.CenterOutGradient;
                break;
              case DirectionalRendering.CenterOutGradient:
                directionalRendering.current =
                  DirectionalRendering.TrapezoidTile;
                break;
              case DirectionalRendering.TrapezoidTile:
                directionalRendering.current =
                  DirectionalRendering.CenterInGradient;
                break;
            }
          }}
          style={{
            backgroundColor: "#555555", // Off-black button background
            color: "white", // White text
            border: "none",
            borderRadius: "5px",
            padding: "5px 15px",
            cursor: "pointer",
          }}
        >
          Rendering: {directionalRendering.current}
        </button>
      </div>

      {/* Speed Slider */}
      <div
        style={{
          position: "fixed", // Fixes the position relative to the viewport
          bottom: "20px", // Distance from the bottom of the viewport
          right: "20px", // Distance from the right of the viewport
          backgroundColor: "rgba(0, 0, 0, 0.7)", // Semi-transparent background
          padding: "10px",
          borderRadius: "8px", // Rounded corners
          color: "white",
          textAlign: "center",
        }}
      >
        <label
          htmlFor="speed-slider"
          style={{ display: "block", marginBottom: "5px", fontSize: "35px" }}
        >
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

        {/* Discrete tally below speed slider */}
        <div
          style={{
            fontSize: "18px",
            color: "rgba(255,255,255,0.5)",
            marginTop: "5px",
            textAlign: "left",
          }}
        >
          <label
            htmlFor="gravity-slider"
            style={{ display: "block", marginBottom: "5px", fontSize: "35px" }}
          ></label>
          <input
            id="gravity-slider"
            type="range"
            min="0"
            max="400"
            step="0.1"
            value={gravity.current}
            onChange={(e) => (gravity.current = parseFloat(e.target.value))}
            style={{
              width: "150px",
              appearance: "none", // Removes default slider styles
              background: "#333333", // Off-black background for the slider track
              borderRadius: "5px",
              height: "10px", // Custom track height
              outline: "none", // Removes outline on focus
            }}
          />
          <div style={{ marginTop: "10px" }}>
            <button
              onClick={() => {
                gravity.current = radiusOct * 0.6;
              }}
              style={{
                backgroundColor: "#555555", // Off-black button background
                color: "white", // White text
                border: "none",
                borderRadius: "5px",
                padding: "5px 10px",
                marginRight: "10px",
                cursor: "pointer",
              }}
            >
              60%
            </button>
            <button
              onClick={() => {
                gravity.current = radiusOct * 0.3;
                gravityClosin.current = !gravityClosin.current;
              }}
              style={{
                backgroundColor: "#555555", // Off-black button background
                color: "white", // White text
                border: "none",
                borderRadius: "5px",
                padding: "5px 10px",
                cursor: "pointer",
              }}
            >
              Closin
            </button>
          </div>

          <style>
            {`
     #gravity-slider::-webkit-slider-thumb {
       appearance: none;
       width: 20px;
       height: 20px;
       border-radius: 50%;
       background: #555555; // Off-black color for the thumb
       border: none;
       cursor: pointer;
     }
     #gravity-slider::-moz-range-thumb {
       width: 20px;
       height: 20px;
       border-radius: 50%;
       background: #555555; // Off-black color for the thumb
       border: none;
       cursor: pointer;
     }
     #gravity-slider::-ms-thumb {
       width: 20px;
       height: 20px;
       border-radius: 50%;
       background: #555555; // Off-black color for the thumb
       border: none;
       cursor: pointer;
     }
     #gravity-slider::-webkit-slider-runnable-track {
       background: #333333; // Off-black track background
       border-radius: 5px;
       height: 10px; // Custom track height
     }
     #gravity-slider::-moz-range-track {
       background: #333333; // Off-black track background
       border-radius: 5px;
       height: 10px; // Custom track height
     }
     #gravity-slider::-ms-track {
       background: #333333; // Off-black track background
       border-radius: 5px;
       height: 10px; // Custom track height
       border-color: transparent;
       border-width: 0;
       color: transparent;
     }
   `}
          </style>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        width={1600}
        height={960}
        style={{
          border: "1px dotted black",
          marginTop: "100px", // Adjust this value as needed
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "20px",
          right: "20px",
          width: "50px",
          height: "50px",
          backgroundColor: isLocked ? "red" : "green",
          cursor: "pointer",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          color: "white",
          fontWeight: "bold",
          border: "2px solid white",
          borderRadius: "5px",
        }}
        onClick={togglePointerLock}
      >
        {isLocked ? "🔒" : "🔓"}
      </div>
    </div>
  );
};

export default PointerLockWrapper;
