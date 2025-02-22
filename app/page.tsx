"use client";

import React, {
  useRef,
  useEffect,
  useState,
  Suspense,
  useCallback,
} from "react";
import { useSearchParams } from "next/navigation";

import VelocityZmqListener, { DecodePacket } from "./ZmqListener";
import ZmqClient from "./ZmqClient";

import {
  Tree,
  allWords,
  allWordsForCode,
  WordFrequency,
  getSubtree,
  getRankedMatches,
  orderByMostFrequent,
  pickWordViaGPT,
} from "./words";

interface Dictionary {
  [t9Code: string]: string[];
}

interface OctagonSide {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface KeyTarget {
  labels: string[];
  x: number;
  y: number;
  idx: number; // Index of side mappings this should correspond to.
  width?: number;
  height?: number;
}

enum KeyboardType {
  Octagon = "octagon",
  Dots = "dots",
}

enum OctagonPage {
  Keyboard = "keyboard",
  Home = "home",
  Settings = "settings",
}

enum DirectionalRendering {
  CenterOutGradient = "Center Out",
  CenterInGradient = "Center In",
  TrapezoidTile = "Trapezoid",
}

enum DwellZoneRendering {
  Never = "none",
  OnHover = "OnHover",
  Visible = "visible",
}

import "@fontsource/poppins"; // Defaults to weight 400
import "@fontsource/press-start-2p";
import { dot } from "node:test/reporters";

const PointerLockWrapper: React.FC = () => {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PointerLockDemo />
    </Suspense>
  );
};

const nSides = 8;

// Cursed: without this, firefox will complain that Symbol.dispose is not found.
// Symbol.dispose ??= Symbol.for("Symbol.dispose");

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

  const directionalMode = useRef<boolean>(false);
  // const directionalRendering = useRef<DirectionalRendering>(DirectionalRendering.CenterOutGradient);
  const directionalRendering = useRef<DirectionalRendering>(
    DirectionalRendering.TrapezoidTile,
  );

  const dwellDurationMs = useRef<number>(500);

  const dwellZoneRendering = useRef<DwellZoneRendering>(
    DwellZoneRendering.Visible,
  );

  const renderCursorTrail = useRef<boolean>(false);

  const radiusOct = 350;
  const dwellZoneRadius = useRef<number>(radiusOct - 50);

  useEffect(() => {
    zmqService.current.start();

    return () => {
      zmqService.current.stop();
    };
  }, []);

  useEffect(() => {
    function handleDecodeData(data: DecodePacket) {
      // if (systemCursorEnabled) {
      //   return;
      // }

      velocities.current = data;
    }

    zmqService.current.events.on(ZmqClient.EVENT_MESSAGE, handleDecodeData);

    return () => {
      zmqService.current.events.off(ZmqClient.EVENT_MESSAGE, handleDecodeData);
    };
  }, []);

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // A) CANVAS + POINTER LOCK STATE
  // ─────────────────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const position = useRef({ x: 800, y: 600 });

  const maxTrail = 50;
  const cursorTrail = useRef(new Array(maxTrail).fill(null));

  // Track collision so we don't spam the same side
  const lastHitSide = useRef<number | null>();

  // The lines making up the octagon, if needed for reference
  const [octagonSides, setOctagonSides] = useState<OctagonSide[]>([]);

  const activePage = useRef<OctagonPage>(OctagonPage.Keyboard);

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

  // Track if each side is in the dwell state
  const isInDwell = useRef<boolean[]>(Array(nSides).fill(false));
  const handleDwellEnd = useRef<boolean[]>(Array(nSides).fill(false));

  // Dwell click
  const dwellClickMode = useRef<boolean>(false);
  const dwellClicked = useRef<boolean[]>(Array(nSides).fill(false));
  const dwellClickThreshold = useRef<number>(100);

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

  const homeLabels: Record<number, string> = {
    1: "Clear",
    2: " ⚙️",
    3: "▢",
    4: "🗣️",
    5: "🔤 ",
    6: "Target Mode",
    7: "📝 Practice",
    8: "🕹️Game",
  };

  const settingsLabels: Record<number, string> = {
    1: "Threshold on",
    2: "Threshold off",
    3: "▢",
    4: "",
    5: "",
    6: "",
    7: "",
    8: "",
  };

  // If you want bold labels around the octagon:
  const getSideLabels = (type: string): Record<number, string> => {
    switch (type) {
      case "abc":
        return {
          1: "␣",
          2: "V W X Y Z",
          3: "▢",
          4: "Q R S T U",
          5: "⌫",
          6: "A B C D E F",
          7: "G H I J K",
          8: "L M N O P",
        };
      // case "abc4":
      //   return {
      //     1: "␣",
      //     2: "?",
      //     3: "▢",
      //     4: "U V W X Y Z",
      //     5: "⌫",
      //     6: "A B C D E F G",
      //     7: "H I J K L M",
      //     8: "N O P Q R S T",
      //   };
      case "abc5":
        return {
          1: "␣",
          2: "V W X Y Z",
          3: "▢",
          4: "Q R S T U",
          5: "⌫",
          6: "A B C D E F",
          7: "G H I J K",
          8: "L M N O P",
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
      case "opt":
        return {
          1: "␣",
          2: "F I K L W Y Z",
          3: "▢",
          4: "A G J N P X",
          5: "⌫",
          6: "E B S U V",
          7: "T O M",
          8: "H C D Q R",
        };
      default:
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
    }
  };

  // From letter -> code
  const createReverseMapping = (type: string): Record<string, number> => {
    const mapping = getSideLabels(type);
    const reverseMapping: Record<string, number> = {};

    for (const [key, value] of Object.entries(mapping)) {
      const code = parseInt(key, 10);
      const letters = value.split(" "); // Split letters by space
      for (const letter of letters) {
        reverseMapping[letter] = code;
      }
    }
    reverseMapping[" "] = 1;

    return reverseMapping;
  };

  const getTreeJson = (type: string): string => {
    switch (type) {
      case "abc":
        return "/code_tree.json";
      case "abc5":
        return "/code_tree_abc5.json";
      // case "abc4":
      //   return "/code_tree_abc4.json";
      case "opt":
        return "/code_tree_opt.json";
      default:
        console.error("Unsupported!");
        return "/code_tree_opt.json";
    }
  };

  const getPreComputedJson = (type: string): string => {
    switch (type) {
      case "abc":
        return "/precomputed.json";
      case "abc5":
        return "/precomputed_abc5.json";
      // case "abc4":
      //   return "/precomputed_abc4.json";
      case "opt":
        return "/precomputed_opt.json";
      default:
        console.error("Unsupported!");
        return "/precomputed_opt.json";
    }
  };

  const speakWords = (): void => {
    const text = theWords.current.join(" ");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.75; // Speed (0.1 - 10, default: 1)
    utterance.pitch = 1; // Pitch (0 - 2, default: 1)
    utterance.volume = 1; // Volume (0 - 1)

    const voices = speechSynthesis.getVoices();
    utterance.voice =
      voices.find((v) => v.name.includes("Eddy (English (US))")) || null;

    speechSynthesis.speak(utterance);
  };

  const startGameMode = (): void => {
    console.log("runs");
    theCodes.current = [];
    theWords.current = [];
    console.log("Resetting code");
    code.current = "";

    inLights.current = true;
    indexRefCode.current = 0;
    indexSentence.current = 0;

    let rng = Math.floor(Math.random() * sentences.length);

    refCode.current = [
      7, 1, 6, 8, 1, 6, 1, 4, 6, 6, 4, 7, 6, 7, 6, 6, 1, 4, 8, 1, 8, 2, 1, 6, 6, 8, 8, 2, 6, 6, 1
    ];
    sentence.current = ["I", "am", "a", "sacrifice", "to", "my", "beloved"];

    //calculations
    goodHits.current = 0;
    badHits.current = 0;

    timerStart.current = performance.now();
  };

  const startPracticeMode = (): void => {
    theWords.current = [];
    theCodes.current = [];
    dirtyWords.current = [];
    code.current = "";

    // isPlaying.current = true;
    isPlaying.current = false;
    setVideoOpacity(0);

    console.log("runs");

    inPractice.current = true;
    indexRefCode.current = 0;
    indexSentence.current = 0;

    // let rng2 = 24;
    let rng2 = Math.floor(Math.random() * sentences.length);

    randomyt.current = yts[rng2];

    refCode.current = [
      7, 6, 8, 8, 8, 1, 2, 8, 4, 8, 6, 1
    ];
    sentence.current = ["hello", "world"];

    //calculations
    goodHits.current = 0;
    badHits.current = 0;

    timerStart.current = performance.now();

    //debug
    console.log("index ref code: " + indexRefCode.current);
    console.log("ref code: " + refCode.current);
  };

  const stopPracticeMode = (): void => {
    inLights.current = false;
    inPractice.current = false;
    isPlaying.current = false;
    setVideoOpacity(0);
    refCode.current = undefined;
    indexRefCode.current = undefined;
    sentence.current = undefined;
    indexSentence.current = undefined;

    textWidth.current = undefined;
    wordSubstringer.current = 0;

    goodDotHits.current = 0;
    badDotHits.current = 0;
    timerDotStart.current = 0;

    
  };

  //
  // ─────────────────────────────────────────────────────────────────────────────
  // E) LOAD DICTIONARY ONCE
  // ─────────────────────────────────────────────────────────────────────────────

  const [dictionaryType, setDictionaryType] = useState("abc5");

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
            fetch(getTreeJson(dictionaryType)).then((res) => res.json()),
            fetch("/trigram_model.json").then((res) => res.json()),
            fetch("/word_freq.json").then((res) => res.json()),
            // fetch("/precomputed.json").then((res) => res.json()),
            fetch(getPreComputedJson(dictionaryType)).then((res) => res.json()),
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
  }, [dictionaryType]);

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

    if (inPractice.current) {
      return;
    }

    Promise.resolve().then(async () => {
      // ====== All possible, sorted by probability
      // const possibleWords =
      //   code.length === 1
      //     ? precomputedTrees.current[code]
      //     : orderByMostFrequent(allWords(getSubtree(code.current, codeTree.current), ""), wordFreq.current);

      // ====== GPT
      // possibleWords.current = await pickWordViaGPT(possibleWords, theWords.current);

      // ===== Exact matches
      // if (code.current.length < 5) {
      //   // If under 5 characters, only pull from words with exact code-length matches.
      //   possibleWords.current = getRankedMatches(
      //     theWords.current,
      //     code.current,
      //     codeTree.current,
      //     trigrams.current,
      //     wordFreq.current,
      //     precomputedTrees.current,
      //     false,
      //   );
      // } else {
      // After the 5th letter, begin to suggest autocompletions with the tree
      // + ngram ordering.
      possibleWords.current = getRankedMatches(
        theWords.current,
        code.current,
        codeTree.current,
        trigrams.current,
        wordFreq.current,
        precomputedTrees.current,
        true,
      );
      // }

      console.log("Ranked: ", possibleWords.current);
      console.timeEnd("getRankedMatches Execution Time");
    });
  }, [code.current]);

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

  // const gravityDefault = 0.27 * radiusOct;
  const gravityDefault = 0.27 * radiusOct;
  const gravity = useRef<number>(gravityDefault);

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

      console.log("Chose candidate");
      chosenWord = candidates[0];
      if (chosenWord === "i") {
        chosenWord = "I";
      }

      // 3) Append the chosen word and code
      //
      if (chosenWord !== undefined && chosenWord !== "") {
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
      }
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

  //PRACTICE MODE: Next steps... (1) Make sentences interesting (2) Metrics to optimize for (3) more gamified jawns
  const inPractice = useRef<boolean>(false);
  const inGameMode = useRef<boolean>(false); // Hack: just used for tracking display
  const textWidth = useRef<number>();
  const wordSubstringer = useRef<number>(0);

  const sentences = [
    // "all you got to do is meet me at the apt apt apt apt",
    // "i want your ugly I want your disease i want your everything as long as its free",
    // "heartbreakers gonna break fakers gonna fake im just gonna shake",
    // "in this world concrete flowers grow heartache she only doing what she know",
    // "for some reason i cant explain i know saint peter wont call my name",
    "its time to focus on life fah fah fah",
    "can you speak to the part you are not all good with",
    // "we have been investing in infrastructure to scale things",
    "and I asked him do I look like I would know",
    "mama just killed a man put a gun onto his head",
    // "remember to let her into your heart and then you can start",
    "somewhere over the rainbow bluebirds fly",
    "your skin oh yeah your skin and bones",
    "i have gotten older now I know how to take care",
    "how come when I returned you were gone away",
    // "i was losing my mind because the love the love the love wasted on a nice face",
    "no way it was the last night that we break up",
    // "the sound of gunfire off in the distance Im getting used to it now",
    "this time the lazy dog jumps over the quick brown fox",
    "lets party arabic style",
    "the democrats will lose the election",
    "was an arizona ranger wouldnt be too long in town",
    // "i am cold can you hear I will fly with no hope no fear",
    "shall we play a game",
    "see you later space cowboy",
    "i sell propane and propane accessories",
    "despite all my rage i am still just a rat in a cage",
    "cowboy hat from gucci wrangler on my booty",
    "wanna be a gun slinger dont be a rock singer",
    "i program my home computer beam myself into the future",
    "it was an experiment in psychogeography",
  ];

  const sentenceToCodes = (sentence: string, type: string): number[] => {
    const reverseMapping = createReverseMapping(type);

    const codes = sentence
      .toUpperCase()
      .split("")
      .map((char) => reverseMapping[char] ?? 0);

    // Hazard: assumes space is 1
    if (codes.length === 0 || codes[codes.length - 1] !== 1) {
      codes.push(1);
    }

    return codes;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // if (systemCursorEnabled) {
      const handleClick = () => {
        // if (document.pointerLockElement === canvas) {
        //   document.exitPointerLock(); // Exit pointer lock if already active
        // } else {
        //   canvas.requestPointerLock(); // Enter pointer lock if not active
        // }
      };

      // const lockChangeAlert = () => {
      //   if (document.pointerLockElement === canvas) {
      //     console.log("Pointer lock activated.");
      //     document.addEventListener("mousemove", handleMouseMove);
      //   } else {
      //     console.log("Pointer lock deactivated.");
      //     document.removeEventListener("mousemve", handleMouseMove);
      //   }
      // };

      // if (!velocities) {
      //   document.addEventListener("mousemove", handleMouseMove);
      // }
      document.addEventListener("mousemove", handleMouseMove);

      canvas.addEventListener("click", handleClick);
      // document.addEventListener("pointerlockchange", lockChangeAlert);

      return () => {
        canvas.removeEventListener("click", handleClick);
        // document.removeEventListener("pointerlockchange", lockChangeAlert);
      };
    // }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // K) HANDLE MOUSE MOVE
  // ─────────────────────────────────────────────────────────────────────────────

  const refractory = useRef<boolean>(false);
  const activeSide = useRef<number | null>(null);
  const selectionRefractory = useRef<boolean>(false);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // console.log("running handleMouseMove()");
    // if (systemCursorEnabled) {
      if (!refractory.current) {
        if (canvasRef.current === null) {
          return;
        }

        const rect = canvasRef.current.getBoundingClientRect();
        const newX = e.clientX - rect.left;
        const newY = e.clientY - rect.top;

        position.current = { x: newX, y: newY };
      } else {
        setTimeout(() => {
          refractory.current = false;
        }, 0);
      }
    // }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // L) COLLISION CHECK => ADD CHAR OR FINALIZE IF SPACE
  // ─────────────────────────────────────────────────────────────────────────────

  //
  const isDotOutsideSide = useCallback(
    (dotX: number, dotY: number, side: OctagonSide) => {
      if (inDiagnostics.current) {
        return;
      }
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
    (
      dotX: number,
      dotY: number,
      side: OctagonSide,
      cutoff = 0.11 * radiusOct,
    ) => {
      if (inDiagnostics.current) {
        return;
      }

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

      // return distance <= gravity.current;
      return distance <= cutoff;
    },
    [],
  );

  const multiplier = useRef<number>(0.7);

  type Point = { x: number; y: number };

  const isPointInPolygon = useCallback((point: Point, polygon: Point[]) => {
    if (inDiagnostics.current) {
      return;
    }
    const x = point.x;
    const y = point.y;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      if (yi > y !== yj > y) {
        const intersectX = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (x < intersectX) {
          inside = !inside;
        }
      }
    }

    return inside;
  }, []);

  const centerX = 800;
  const centerY = 600;

  const directions = 8; // Total directions
  const angleStep = (2 * Math.PI) / directions; // Angle between each direction

  const initialDistances = [100, 200]; // Initial distances from the center

  const predictedWord = useRef<String>();

  function predictTheWord() {
    code.current;
  }
  const inDiagnostics = useRef<boolean>(true);

  const inMagicBricks = useRef<boolean>(true);

  const showCursor = useRef<boolean>(false);

  const lockCursor = useRef<boolean>(false);

  const showTargets = useRef<boolean>(false);
  const lineStartPoints = [
    { startX: 500, startY: 280 }, // Distance 100, Angle 0 degrees (East)
    { startX: 500, startY: 180 }, // Distance 200, Angle 0 degrees (East)
    { startX: 1000, startY: 180 }, // Distance 100, Angle 45 degrees (NE)
    { startX: 1100, startY: 180 }, // Distance 200, Angle 45 degrees (NE)
  ];

  const lineEndPoints = [
    { startX: 1100, startY: 280 }, // Distance 100, Angle 0 degrees (East)
    { startX: 1100, startY: 180 }, // Distance 200, Angle 0 degrees (East)
    { startX: 1000, startY: 780 }, // Distance 100, Angle 45 degrees (NE)
    { startX: 1100, startY: 780 }, // Distance 200, Angle 45 degrees (NE)
  ];
  const targetIndex = useRef<number>(-1);

  const velocityBelowThresholdStartTime = useRef<number>(0); // Track when velocity first goes below threshold
  const dwellTimeRequired = useRef<number>(60); // Time in milliseconds (1 second)
  const fast = useRef<boolean>(false);
  ``;
  // const fastThreshold = useRef<number>(300);
  const fastThreshold = useRef<number>(300);

  const dotGameMode = useRef<boolean>(false);
  const dotArrowMode = useRef<boolean>(false);

  //timeElapsed
  const timeElapsed = useRef<number>();
  const dwellBrickTime = useRef<number>(700);
  const dwellBrickRefractory = useRef<number>(500);

  const octagonTargetMode = useRef<boolean>(false);
  const gameDotSequence = [
    5, 2, 7, 2, 1, 0, 5, 4, 1, 4, 7, 0, 4, 5, 0, 4, 0, 2, 4, 1, 5, 2, 0, 5, 4,
    0, 2, 0, 5, 7,
  ];
  const indexGameDot = useRef<number>(0);

  const goodDotHits = useRef<number>(0);
  const badDotHits = useRef<number>(0);

  const timerDotStart = useRef<number>(); //timer
  const timerDotEnd = useRef<number>();
  const timeDotLength = useRef<number>();

  const dotCcpm = useRef<number>();
  const snapBackMode = useRef<boolean>(false);

  // Magic keys
  const activeKeyIdx = useRef<number | null>(null);
  const clickedKeyIdx = useRef<number | null>(null);
  const clickedKey = useRef<KeyTarget | null>(null);
  const justHit = useRef<boolean>(true);

  const inDotPractice = useRef<boolean>(false);

  const refractoryStart = useRef<number>();

  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    //
    // (1) DRAW THE OCTAGON AND SIDES
    //

    
    const centerX = 800;
    const centerY = 600;
    

    const radius = radiusOct;
    const innerRadius = dwellZoneRadius.current;

    const sides = nSides;
    const angleStep = (2 * Math.PI) / sides;
    const rotation = Math.PI / 8;

    // Anchors for suggestion words
    const suggestionsY = centerY + canvas.height / 2 / 5;

    const newSides: OctagonSide[] = [];

    let touchingVelocity = false;

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

        if (true) {
          const delta2X = vertexInnerX - prevInnerX!;
          const delta2Y = vertexInnerY - prevInnerY!;
          const innerOffsetStartX = prevInnerX! + delta2X * 0;
          const innerOffsetStartY = prevInnerY! + delta2Y * 0;

          const innerOffsetEndX = prevInnerX! + delta2X * 1;
          const innerOffsetEndY = prevInnerY! + delta2Y * 1;

          let innerSide: OctagonSide = {
            startX: innerOffsetStartX,
            startY: innerOffsetStartY,
            endX: innerOffsetEndX,
            endY: innerOffsetEndY,
          };
          const gradient = ctx.createLinearGradient(
            (innerOffsetStartX + innerOffsetEndX) / 2,
            (innerOffsetStartY + innerOffsetEndY) / 2,
            (startOffsetX + endOffsetX) / 2,
            (startOffsetY + endOffsetY) / 2,
          );

          let style: CanvasGradient | string | undefined;

          const coordinates: Point[] = [
            { x: startOffsetX, y: startOffsetY },
            { x: endOffsetX, y: endOffsetY },
            { x: innerOffsetEndX, y: innerOffsetEndY },
            { x: innerOffsetStartX, y: innerOffsetStartY },
          ];

          if (
            dwellClickMode.current &&
            Math.abs(velocities.current?.final_velocity_x ?? 0) +
              Math.abs(velocities.current?.final_velocity_y ?? 0) <
              100
          ) {
            touchingVelocity =
              isPointInPolygon(
                { x: position.current.x, y: position.current.y },
                coordinates,
              ) || false;
          }

          let idx = i - 1;
          if (
            isPointInPolygon(
              { x: position.current.x, y: position.current.y },
              coordinates,
            )
          ) {
            if (dwellZoneRendering.current == DwellZoneRendering.Never) {
              style = `rgba(0, 0, 0)`;
            } else {
              style = `rgba(0, 100, 0)`;
            }

            if (!isInDwell.current[idx]) {
              isInDwell.current[idx] = true;
              setTimeout(() => {
                // HACK: set this bit & let the isTouching logic handle it.
                if (isInDwell.current[idx]) {
                  handleDwellEnd.current[idx] = true;
                }
                isInDwell.current[idx] = false;
              }, dwellDurationMs.current);
            }
          } else {
            isInDwell.current[idx] = false;

            if (
              dwellZoneRendering.current == DwellZoneRendering.Visible &&
              !inDiagnostics.current
            ) {
              style = `rgba(0, 25, 0)`;
            } else {
              style = `rgba(0, 0, 0)`;
            }
          }

          if (
            dwellClickMode.current &&
            Math.abs(velocities.current?.final_velocity_x ?? 0) +
              Math.abs(velocities.current?.final_velocity_y ?? 0) <
              dwellClickThreshold.current
          ) {
            let touchingVelocity =
              isPointInPolygon(
                { x: position.current.x, y: position.current.y },
                coordinates,
              ) || false;
            if (touchingVelocity) {
              dwellClicked.current[idx] = true;
            }
          } else {
            dwellClicked.current[idx] = false;
          }

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

    if (
      inPractice.current &&
      !dotArrowMode.current &&
      sentence.current !== undefined &&
      indexSentence.current !== undefined
    ) {
      //If in practice mode...
      //display the current word being built
      ctx.font = "69px Poppins";
      ctx.fillStyle = "gray";
      textWidth.current = ctx.measureText(
        sentence.current[indexSentence.current],
      ).width;
      ctx.fillText(sentence.current[indexSentence.current], centerX, centerY);

      //display what has been typed so far
      ctx.textAlign = "left";
      ctx.fillStyle = "white";

      if (
        sentence.current !== undefined &&
        indexSentence.current !== undefined &&
        wordSubstringer.current !== 0
      )
        ctx.fillText(
          sentence.current[indexSentence.current].substring(
            0,
            wordSubstringer.current,
          ),
          centerX - textWidth.current / 2,
          centerY,
        );
      ctx.textAlign = "center";
      ctx.fillStyle = "gray";
    }

    //
    // (2) CHECK COLLISIONS
    //

    newSides.forEach((side, index) => {
      const sideIndex = index + 1;

      let touching = false;
      // let touching = isDotOutsideSide(position.current.x, position.current.y, side)
      // isDotTouchingSide(position.current.x, position.current.y, side) ||

      if (
        !dwellClickMode.current &&
        handleDwellEnd.current[index] &&
        isInDwell.current[index]
      ) {
        touching = true;
        handleDwellEnd.current[index] = false;
      }

      if (dwellClickMode.current && dwellClicked.current[index]) {
        touching = true;
        dwellClicked.current[index] = false;
      }

      if (selectionRefractory.current) {
        touching = false;
      }

      // If the dot is past the inner threshold, activate the dwell region.
      if (touching) {
        if (timeLength.current !== undefined) {
          timeLength.current = undefined;
          timerEnd.current = undefined;
          timerStart.current = undefined;
          goodHits.current = undefined;
          badHits.current = undefined;
        }

        const pageChangeOccured = handlePageInteractions(sideIndex);
        console.log("PAGE CHANGE: " + pageChangeOccured);

        if (
          //If you are in Game or Practice mode, you only get the right hit sound if you hit the right one
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
          if (inPractice.current && wordSubstringer.current !== undefined) {
            //If you are in practice mode, append the next character
            wordSubstringer.current += 1;
          }
        }

        if (
          //If not in Game/Practice mode OR (They are in Game/Practice mode AND hit the right side)
          indexRefCode.current === undefined ||
          (refCode.current &&
            indexRefCode.current !== undefined &&
            sideIndex === refCode.current[indexRefCode.current])
        ) {
          handleTypingInteraction(sideIndex, pageChangeOccured);
        }
        refractory.current = true;

        let refractoryTimeout = 50;
        if (snapBackMode.current) {
          // position.current = { x: 800, y: 600 };
        } else {
          const snapX = (position.current.x + 800) / 2;
          const snapY = (position.current.y + 600) / 2;

          // position.current = { x: snapX, y: snapY };
          refractoryTimeout = 200;
        }

        activeSide.current = sideIndex;
        setTimeout(() => {
          activeSide.current = null;
        }, refractoryTimeout);

        selectionRefractory.current = true;
        setTimeout(() => {
          selectionRefractory.current = false;
        }, 500);

        // No collision
      } else if (
        !inPractice.current &&
        refCode.current &&
        indexRefCode.current !== undefined &&
        refCode.current[indexRefCode.current] == sideIndex &&
        !octagonTargetMode.current
      ) {
        //when not touching and in Game mode
        ctx.fillStyle = "yellow";
        ctx.font = "127px Arial";
        switch (refCode.current[indexRefCode.current]) {
          case 1:
            ctx.fillText("→", centerX, centerY);
            break;
          case 2:
            ctx.fillText("↘", centerX, centerY);
            break;
          case 3:
            ctx.fillText("↓", centerX, centerY);
            break;
          case 4:
            ctx.fillText("↙", centerX, centerY);
            break;
          case 5:
            ctx.fillText("←", centerX, centerY);
            break;
          case 6:
            ctx.fillText("↖", centerX, centerY);
            break;
          case 7:
            ctx.fillText("↑", centerX, centerY);
            break;
          case 8:
            ctx.fillText("↗", centerX, centerY);
            break;
        }
        ctx.fillStyle = "white";
      }

      if (!inDiagnostics.current) {

        if (activeSide.current === sideIndex) {
          ctx.strokeStyle = "white";
        } else {
          ctx.strokeStyle = "rgba(0, 124, 56)"; // Green
        }

        if (
          octagonTargetMode.current &&
          refCode.current &&
          indexRefCode.current !== undefined &&
          refCode.current[indexRefCode.current] == sideIndex
        ) {
          ctx.strokeStyle = "yellow";
        }

        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.moveTo(side.startX, side.startY);
        ctx.lineTo(side.endX, side.endY);
        ctx.stroke();
      }

    });

    //
    // 3) Draw Labels
    //

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (inDiagnostics.current) {
      // ctx.fillStyle = "black";
      ctx.fillStyle = "white";
    } else {
      ctx.fillStyle = "white";
    }

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

      // Only render labels inside octagon for now.
      if (!inDiagnostics.current) {
        ctx.fillStyle = "white";
        switch (activePage.current) {
          case OctagonPage.Keyboard:
            ctx.fillText(sideLabels[sideIndex], labelX, labelY);
            break;
          case OctagonPage.Home:
            // Handle practice mode
            if (inPractice.current && sideIndex == 7) {
              ctx.font = "bold 30px Poppins, sans-serif";
              ctx.fillText("❌ Quit Practice", labelX, labelY);
            } else if (inGameMode.current && sideIndex == 8) {
              ctx.font = "bold 30px Poppins, sans-serif";
              ctx.fillText("❌ Quit Game", labelX, labelY);
            } else {
              ctx.fillText(homeLabels[sideIndex], labelX, labelY);
            }
            break;
          case OctagonPage.Settings:
            ctx.fillText(settingsLabels[sideIndex], labelX, labelY);
            break;
        }
      }
    });

    //
    // 4) Draw Dot
    //
    if (!dataReady.current) {
      ctx.fillStyle = "orange";
    } else {
      ctx.fillStyle = "lightgray";
    }
    ctx.beginPath();

    // const cursorSize = directionalMode.current ? 0 : 11;
    const cursorSize = showCursor.current ? 0 : 20;

    const curX = lockCursor.current ? centerX : position.current.x;
    const curY = lockCursor.current ? centerY : position.current.y;

    ctx.arc(curX, curY, cursorSize, 0, 2 * Math.PI);
    ctx.fill();

    if (renderCursorTrail.current) {
      cursorTrail.current.forEach((pos, i) => {
        if (!pos) return;
        let alpha = (i + 1) / maxTrail;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, cursorSize, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(211, 211, 211, ${alpha})`;
        ctx.fill();
      });

      cursorTrail.current.push({ x: curX, y: curY });
      if (cursorTrail.current.length > maxTrail) cursorTrail.current.shift();
    }

    // Using monospace font because it is easier to render– sorry Sehej BRUH
    ctx.font = inDiagnostics.current ? "40px Monaco" : "80px Monaco";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (code.current.length === 0 && !inLights.current && !inPractice.current) {
      // Display last word from theWords.current if it exists
      const lastWord = theWords.current[theWords.current.length - 1] || "";

      ctx.fillText(lastWord, centerX, centerY);

      // Only display suggestions when we are also displaying a current word.
      if (lastWord !== "") {
        // Draw suggestions on screen
        ctx.font = inDiagnostics.current ? "25px Monaco" : "30px Monaco";
        ctx.fillStyle = "grey";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        let cur_index = possibleWords.current.indexOf(lastWord);

        let currentY = suggestionsY;
        // Show 3 suggestions max
        let suggestions = possibleWords.current.slice(
          Math.min(cur_index + 1, possibleWords.current.length),
        );
        let n_suggest = 0;
        let i = 0;
        while (
          n_suggest < Math.min(suggestions.length, 3) &&
          i < suggestions.length
        ) {
          if (suggestions[i] === lastWord) {
            i += 1;
            continue;
          }
          const buffer = inDiagnostics.current ? 65 : 0;
          ctx.fillText(suggestions[i], centerX, currentY - buffer);
          currentY += 35;
          n_suggest += 1;
          i += 1;
        }
      }

    } else {
      if (possibleWords.current.length > 0 && !inPractice.current) {
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
            ctx.fillStyle = "gray";
          }

          ctx.fillText(char, currentX, centerY);
          currentX += ctx.measureText(char).width;
        }

        if (code.current.length > 0) {
          // Draw suggestions on screen
          ctx.font = inDiagnostics.current ? "25px Monaco" : "30px Monaco";
          const buffer = inDiagnostics.current ? 65 : 0;
          ctx.fillStyle = "grey";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          let currentY = suggestionsY;

          // Show 3 suggestions max
          const lastWord = theWords.current[theWords.current.length - 1] || "";
          let cur_index = possibleWords.current.indexOf(lastWord);

          let suggestions = possibleWords.current.slice(
            Math.min(cur_index + 1, possibleWords.current.length),
          );
          let n_suggest = 0;
          let i = 0;
          while (
            n_suggest < Math.min(suggestions.length, 3) &&
            i < suggestions.length
          ) {
            if (suggestions[i] === bestWord) {
              i += 1;
              continue;
            }
            ctx.fillText(suggestions[i], centerX, currentY - buffer);
            currentY += 35;
            n_suggest += 1;
            i += 1;
          }
        }
      }
    }

    ctx.font = inDiagnostics.current ? "27px Poppins" : "32px Poppins";
    ctx.fillStyle = "#CACACA"; // Faded white color
    const buffer = inDiagnostics.current ? 90 : 0;
    if (!inLights.current && !dotArrowMode.current) {
      ctx.fillText(theWords.current.join(" "), centerX, inMagicBricks.current ? centerY - 350 : centerY - 200 + buffer); // Adjust Y-coordinate to place it above
    }

    //Draw calculations for Game Mode
    if (timerEnd.current) {
      ctx.font = "69px Poppins";
      ctx.fillStyle = "lightgreen"; // Set the text color
      ctx.textAlign = "center"; // Align the text to the left
      ccpm.current =
        (((goodHits.current ?? 0) - 1) / (timeLength.current ?? 1)) * 60000;
      ctx.fillText(`${ccpm.current.toFixed(2)} CCPM`, centerX, centerY + 200);

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

      const exists = leederboredVals.current.some(
        (entry) => entry.ccpm === ccpm.current,
      );
      if (!exists) {
        leederboredVals.current.push({
          player: "borg",
          ccpm: ccpm.current ?? 0,
        });
      }

      inGameMode.current = false;
    }

    //
    // (5) Diagnostics jawns
    //

    if (showTargets.current) {
      //show the target
      ctx.beginPath();
      ctx.moveTo(
        lineEndPoints[targetIndex.current].startX,
        lineEndPoints[targetIndex.current].startY,
      ); // Starting from the center
      ctx.lineTo(
        lineStartPoints[targetIndex.current].startX,
        lineStartPoints[targetIndex.current].startY,
      ); // Line to the zeroth index
      ctx.strokeStyle = "blue"; // Set the line color to blue
      ctx.lineWidth = 14; // Set the line width to be thin
      ctx.stroke(); // Actually draw the line on the canvas
    }

    setOctagonSides(newSides);
  
    //
    // =====================================================================
    //
    //        ~ * ` * ~ Magic keys ~ * ` * ~
    //
    // =====================================================================
    //
    if (inDiagnostics.current && !inMagicBricks.current) {
      //PRACTICE MODE by little B
      let keys: KeyTarget[] = [
        {
          labels: ["A", "B", "C", "D", "E", "F"],
          x: 1 / 2 - (1 / 5) * multiplier.current,
          y: 1 / 2 - (4 / 15) * multiplier.current,
          idx: 6,
        },
        {
          labels: ["G", "H", "I", "J", "K"],
          x: 1 / 2,
          y: 1 / 2 - (4 / 15) * multiplier.current,
          idx: 7,
        },
        {
          labels: ["L", "M", "N", "O", "P"],
          x: 1 / 2 + (1 / 5) * multiplier.current,
          y: 1 / 2 - (4 / 15) * multiplier.current,
          idx: 8,
        },
        { labels: ["⌫"], x: 1 / 2 - (1 / 5) * multiplier.current, y: 1 / 2, idx: 5 },
        { labels: ["␣"], x: 1 / 2 + (1 / 5) * multiplier.current, y: 1 / 2, idx: 1 },
        {
          labels: ["Q", "R", "S", "T", "U"],
          x: 1 / 2 - (1 / 5) * multiplier.current,
          y: 1 / 2 + (4 / 15) * multiplier.current,
          idx: 4,
        },
        { labels: [" "], x: 1 / 2, y: 1 / 2 + (4 / 15) * multiplier.current, idx: -1 },
        {
          labels: ["V", "W", "X", "Y", "Z"],
          x: 1 / 2 + (1 / 5) * multiplier.current,
          y: 1 / 2 + (4 / 15) * multiplier.current,
          idx: 2,
        },
      ];

      keys.forEach((key) => {
        key.x *= canvas.width;
        key.y *= canvas.height;
      });

      for (let i = 0; i < keys.length; i++) {
        /*
         *  Render Text
         *
         */
        let nEntries = keys[i].labels.length;
        for (let selector = 0; selector < nEntries; selector++) {
          const row = Math.floor(selector / 3);
          const col = selector % 3;

          let sep = 30;
          let fsize = multiplier.current * 56;
          ctx.font = `${fsize}px Poppins`;
          if (activeKeyIdx.current !== null && activeKeyIdx.current === i) {
            sep = 50;
            ctx.fillStyle = "lightgray";
          } else if (activeKeyIdx.current !== null) {
            ctx.fillStyle = "rgb(200, 200, 200)";
          } else {
            ctx.fillStyle = "lightgray";
          }

          ctx.fillText(
            keys[i].labels[selector],
            keys[i].x - sep + 1.5 * col * sep,
            keys[i].y - sep + 1.5 * row * sep,
          );
        }

        ctx.beginPath();
        // if (dotGameMode.current) {
        //   if (i === gameDotSequence[indexGameDot.current]) {
        if (refCode.current && indexRefCode.current && dotGameMode.current) {
          if (i+1 === refCode.current[indexRefCode.current]) {
            ctx.fillStyle = "yellow";
          } else {
            // ctx.fillStyle = "#812dfa";
            ctx.fillStyle = "white";
          }
          // Default magic coloring
        } else if (
          dotArrowMode.current &&
          refCode.current &&
          indexRefCode.current !== undefined
        ) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '127px Poppins'; // You can adjust the font size and style as needed

          let arrow = "";
          // switch (refCode.current[indexRefCode.current] - 1) {
          switch (refCode.current[indexRefCode.current] - 1) {
              case 0: // top left
                  arrow = '↖';
                  break;
              case 1: // upwards
                  arrow = '↑';
                  break;
              case 2: // top right
                  arrow = '↗';
                  break;
              case 3: // left
                  arrow = '←';
                  break;
              case 4: // right
                  arrow = '→';
                  break;
              case 5: // bottom left
                  arrow = '↙';
                  break;
              case 6: // bottom
                  arrow = '↓';
                  break;
              case 7: // bottom right
                  arrow = '↘';
                  break;
              default:
                  // Done
                  break;
          }
          ctx.fillText(arrow, centerX, centerY);
        } else {
          ctx.fillStyle = "lightgreen";
        }

        if (!(activeKeyIdx.current !== null && activeKeyIdx.current === i)) {
          ctx.globalAlpha = 0.23;

          let size = 22;
          if (activeSide.current !== null && activeSide.current === i) {
            size = 100;
          }
          ctx.arc(keys[i].x, keys[i].y, size, 0, 2 * Math.PI);

          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (
        Math.abs(velocities.current?.final_velocity_x ?? 0) +
          Math.abs(velocities.current?.final_velocity_y ?? 0) <
          dwellClickThreshold.current &&
        (position.current.x < centerX - 120 ||
          position.current.x > centerX + 120 ||
          position.current.y < centerY - 120 ||
          position.current.y > centerY + 120)
      ) {
        if (velocityBelowThresholdStartTime.current === 0) {
          // Start timing if it's the first time below threshold
          velocityBelowThresholdStartTime.current = Date.now();
        } else {
          // Check if it has been below threshold for the required dwell time
          const timeBelowThreshold =
            Date.now() - velocityBelowThresholdStartTime.current;
          if (timeBelowThreshold >= dwellTimeRequired.current && fast.current) {
            console.log("We reached low velocities in Practisch");

            fast.current = false;
            let hitCircleIndex = findClosestCircle();

            console.log("hitCircleIndex " + hitCircleIndex);

            activeSide.current = hitCircleIndex;
            setTimeout(() => {
              activeSide.current = null;
            }, 200);

            // In game mode
            if (
              refCode.current !== undefined &&
              indexRefCode.current !== undefined
            ) {
              console.log(
                "refCode.current[indexRefCode.current] " +
                  refCode.current[indexRefCode.current],
              );
              if (
                hitCircleIndex + 1 ===
                refCode.current[indexRefCode.current]
              ) {
                //if you hit the rite jawn
                goodDotHits.current++;
                const audio = new Audio("coin2.mp3");
                audio.volume = 0.3; // Reduce volume to 30%
                audio.play()
                  .catch((error) =>
                    console.error("Error playing audio:", error),
                  );

                if (timerDotStart.current === undefined) {
                  //start timer
                  timerDotStart.current = performance.now();
                }

                if (wordSubstringer.current !== undefined) {
                  //If you are in practice mode, append the next character
                  wordSubstringer.current += 1;
                }
                if (
                  hitCircleIndex === 4 &&
                  indexSentence.current !== undefined &&
                  sentence.current !== undefined
                ) {
                  wordSubstringer.current = 0;
                  indexSentence.current++;
                  if (indexSentence.current === sentence.current.length) {
                    //if last character
                    timeDotLength.current =
                      performance.now() - timerDotStart.current;
                    dotCcpm.current =
                      (goodDotHits.current / timeDotLength.current) * 60000;
                    accuracy.current =
                      (goodDotHits.current /
                        (goodDotHits.current + badDotHits.current)) *
                      100;
                  }
                }
                indexRefCode.current++;
              } else {
                badDotHits.current++;
                new Audio("erro.mp3")
                  .play()
                  .catch((error) =>
                    console.error("Error playing audio:", error),
                  );
              }
              if (snapBackMode.current) {
                // position.current = { x: centerX, y: centerY };
              }
            } else {
              handleTypingInteraction(keys[hitCircleIndex].idx, false);
              new Audio("click.mp3")
                .play()
                .catch((error) => console.error("Error playing audio:", error));

            }

            ctx.beginPath();
            ctx.arc(
              keys[hitCircleIndex].x * canvas.width,
              keys[hitCircleIndex].y * canvas.height,
              99,
              0,
              2 * Math.PI,
            );
            ctx.fill();
            // Reset the start time
            velocityBelowThresholdStartTime.current = 0;
          }
        }
      } else {
        // Reset if velocity goes above threshold
        if (
          Math.abs(velocities.current?.final_velocity_x ?? 0) +
            Math.abs(velocities.current?.final_velocity_y ?? 0) >
          fastThreshold.current
        ) {
          fast.current = true;
        }
        velocityBelowThresholdStartTime.current = 0;
      }
      if (dotCcpm.current !== undefined && accuracy.current !== undefined) {
        ctx.font = "69px Poppins"; // Smaller font size
        ctx.fillStyle = "lightgreen"; // Text color
        ctx.fillText(
          `${dotCcpm.current.toFixed(2)} DPM`,
          centerX,
          centerY + 100,
        );
        ctx.font = "32px Poppins"; // Smaller font size
        ctx.fillStyle = "white"; // Text color
        ctx.fillText(`${accuracy.current.toFixed(2)}%`, centerX, centerY + 175);

      }

      function findClosestCircle() {
        // Initialize variables within the function's scope
        let closestIndex = -1;
        let smallestDistance = Infinity;

        for (let i = 0; i < keys.length; i++) {
          let target = keys[i];
          let distance = Math.sqrt(
            Math.pow(target.x - position.current.x, 2) +
              Math.pow(target.y - position.current.y, 2),
          );

          if (distance < smallestDistance) {
            smallestDistance = distance;
            closestIndex = i;
          }
        }

        return closestIndex;
      }
    }

    if (inMagicBricks.current) {

      const blockWidth = 200;
      const blockHeight = 150;
      const horizontalGap = 50;
      const verticalGap = 50;
      const cornerRadius = 15; // Radius for curved corners
      
      // Calculate total width and height of the block arrangement
      const totalWidth = (blockWidth * 3) + (horizontalGap * 2);
      const totalHeight = (blockHeight * 2) + verticalGap;
      
      // Calculate starting position to center the blocks, shifted up by 100px
      const startX = centerX - (totalWidth / 2);
      const startY = centerY - (totalHeight / 2) - 40;

      let keys: KeyTarget[] = [
        {
          labels: ["A", "B", "C", "D", "E", "F"],
          x: startX + (0 * (blockWidth + horizontalGap)),
          y: startY,
          idx: 6,
          width: blockWidth
        },
        {
          labels: ["G", "H", "I", "J", "K"], 
          x: startX + (1 * (blockWidth + horizontalGap)),
          y: startY,
          idx: 7,
          width: blockWidth
        },
        {
          labels: ["L", "M", "N", "O", "P"],
          x: startX + (2 * (blockWidth + horizontalGap)), 
          y: startY,
          idx: 8,
          width: blockWidth
        },
        {
          labels: ["⌫"],
          x: startX - blockWidth - horizontalGap,
          y: startY,
          width: blockWidth,
          height: blockHeight * 3 + verticalGap * 2,
          idx: 5
        },
        {
          labels: ["␣"],
          x: startX,
          y: startY + 2 * blockHeight + 2 * verticalGap,
          width: totalWidth, // Make space bar span full width
          idx: 1
        },
        {
          labels: ["Q", "R", "S", "T", "U"],
          x: startX,
          y: startY + blockHeight + verticalGap,
          idx: 4,
          width: blockWidth
        },
        {
          labels: ["V", "W", "X", "Y", "Z"],
          x: startX + (2 * (blockWidth + horizontalGap)),
          y: startY + blockHeight + verticalGap,
          idx: 2,
          width: blockWidth
        }
      ];


      ctx.fillStyle = "white";

      // Draw blocks and labels
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        
        // Draw dotted block
        ctx.beginPath();
        ctx.setLineDash([5, 5]); // Create dotted line pattern
        const width = key.width || blockWidth; // Use key.width if specified, otherwise use blockWidth
        const height = key.height || blockHeight; // Use key.height if specified, otherwise use blockHeight
        ctx.roundRect(key.x, key.y, width, height, 15);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]); // Reset line pattern

        // Draw labels
        ctx.font = "32px Poppins";
        if (refCode.current && indexRefCode.current && dotGameMode.current) {
          if (key.idx === refCode.current[indexRefCode.current]) {
            ctx.fillStyle = "yellow";
          } else {
            // ctx.fillStyle = "#812dfa";
            ctx.fillStyle = "white";
          }
          // Default magic coloring
        }        
        ctx.textAlign = "center";
        
        // Center the text in the block
        const textX = key.x + width/2; // Use width instead of blockWidth
        const textY = key.y + height/2;
        
        // Draw each letter spaced out
        const spacing = 30;
        key.labels.forEach((label, index) => {
          const letterX = textX - ((key.labels.length-1) * spacing)/2 + (index * spacing);
          ctx.fillText(label, letterX, textY);
        });
      }

      let lastActiveKeyIdx = activeKeyIdx.current;


      // Draw blocks with highlighting
      for (let key of keys) {
        ctx.beginPath();
        ctx.setLineDash([5, 5]); // Create dotted line pattern
        const width = key.width || blockWidth; // Use key.width if specified, otherwise use blockWidth
        const height = key.height || blockHeight; // Use key.height if specified, otherwise use blockHeight

        ctx.roundRect(key.x, key.y, width, height, cornerRadius);
      
        
        // Check if cursor is over this key
        if (position.current.x >= key.x && 
            position.current.x <= key.x + width &&
            position.current.y >= key.y && 
            position.current.y <= key.y + height) {
          
        let opacity = dwellClickMode.current ? 0 : Math.min(((timeElapsed.current || 0) - (refractoryStart.current ? dwellBrickRefractory.current : 0)) / dwellBrickTime.current, 1);
        if (key.idx === clickedKeyIdx.current) {
          opacity = 1;
        }
        ctx.fillStyle = key.idx === 5 ? `rgba(255, 0, 0, ${opacity})` : `rgba(0, 0, 255, ${opacity})`; // Semi-transparent red for idx 5, blue otherwise
          // Only start timer if moving to a new key
          if (activeKeyIdx.current !== key.idx) {
            timerStart.current = performance.now();
            justHit.current = false;
            activeKeyIdx.current = key.idx;
          }

          // Check if enough time has passed since timer started
          if (
            (!dwellClickMode.current && timerStart.current && performance.now() - timerStart.current >= dwellBrickTime.current) ||  
            (dwellClickMode.current &&  Math.abs(velocities.current?.final_velocity_x ?? 0) + Math.abs(velocities.current?.final_velocity_y ?? 0) < dwellClickThreshold.current))
            {
            // Check if we're past refractory period or haven't hit yet
            if (!refractoryStart.current || performance.now() - refractoryStart.current >= dwellBrickTime.current + dwellBrickRefractory.current) {
              new Audio("click.mp3")
                .play()
                .catch((error) => console.error("Error playing audio:", error));
              
              // Handle key click
              if (activeKeyIdx.current !== null) {
                handleTypingInteraction(key.idx, false);

                clickedKey.current = keys[activeKeyIdx.current];
                clickedKeyIdx.current = activeKeyIdx.current;

                setTimeout(() => {
                  clickedKey.current = null;
                  clickedKeyIdx.current = null;
                }, 230);
              }
              
              // Reset timer and set refractory period
              timerStart.current = performance.now();
              refractoryStart.current = performance.now();
            }
          }

          ctx.fill();
        } else if (lastActiveKeyIdx === key.idx) {
          // Reset active key when leaving this key
          activeKeyIdx.current = null;
          timerStart.current = undefined;
          refractoryStart.current = undefined;
        }

        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]); // Reset line pattern
      }

      // Draw dwell timer progress if active
      if (activeKeyIdx.current !== null && timerStart.current) {
        ctx.font = "24px Poppins";
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        timeElapsed.current = Math.floor(performance.now() - timerStart.current);
        //ctx.fillText(`${timeElapsed.current}ms`, position.current.x, position.current.y - 20);
      }

      // Set the font size and style
      ctx.font = '16px Arial'; // You can adjust the size and font as needed
      ctx.textAlign = 'center'; // Center the text horizontally

      // Set the position for the text
      const xPosition = canvas.width / 2; // Center text horizontally
      const yPosition = 20; // Position text a bit below the top edge

      // Draw the text on the canvas
      ctx.fillText(`Clicked Key Index: ${clickedKeyIdx.current}`, xPosition, yPosition);
      
    }
  }, [
    position,
    lastHitSide,
    finalizeCurrentWord,
    sideMappings,
    sideLabels,
    code,
  ]);

  /*
   * Handle navigation interactions based on the selection index.
   *
   * Returns whether or not the page changed as a result of this interaction.
   */
  function handlePageInteractions(selectorIndex: number): boolean {
    // =========== Handle page-dependent interactions with buttons
    let startingPage = activePage.current;
    if (activePage.current === OctagonPage.Keyboard) {
      // Transistion keyboard -> home menu
      if (selectorIndex == 3) {
        activePage.current = OctagonPage.Home;
      }
    } else if (activePage.current === OctagonPage.Home) {
      switch (selectorIndex) {
        // Transistion home -> keyboard
        case 5:
          activePage.current = OctagonPage.Keyboard; // Hack: just used for tracking display
          break;
        // Transistion home -> settings
        case 2:
          activePage.current = OctagonPage.Settings;
          break;
        // Speak
        case 4:
          speakWords();
          break;
        case 6:
          if (!inPractice.current && !inLights.current && !octagonTargetMode.current) {
            inGameMode.current = true;
            octagonTargetMode.current = true;
            startGameMode();
            activePage.current = OctagonPage.Keyboard;
          } else {
            octagonTargetMode.current = false;
            inGameMode.current = false;
            stopPracticeMode();
          }
          break;

        // Practice mode
        case 7:
          if (!inPractice.current && !inLights.current) {
            startPracticeMode();
            activePage.current = OctagonPage.Keyboard;
          } else {
            stopPracticeMode();
          }
          break;

        // Game mode
        case 8:
          if (!inLights.current && !inPractice.current) {
            // startPracticeMode();
            inGameMode.current = true;
            startGameMode();
            activePage.current = OctagonPage.Keyboard;
          } else {
            inGameMode.current = false;
            stopPracticeMode();
          }
          break;
        // Clear all
        case 1:
          console.log("Clearing all text!");
          theWords.current = [];
          theCodes.current = [];
          dirtyWords.current = [];
          code.current = "";
          break;
      }
    } else if (activePage.current === OctagonPage.Settings) {
      switch (selectorIndex) {
        // Transistion settings -> home
        case 3:
          activePage.current = OctagonPage.Home;
          break;

        // Radius on
        case 1:
          gravity.current = 0.4 * radiusOct;
          break;

        // Radius off
        case 2:
          gravity.current = gravityDefault;
          break;
      }
    }

    const pageChange = activePage.current != startingPage;
    console.log("PAGE CHANGE: " + pageChange);

    return pageChange;
  }

  /*
   * Handle a typing interaction on the keyboard
   *
   */
  function handleTypingInteraction(
    selectorIndex: number,
    pageChangeOccured: boolean,
  ) {
    const codeChar = sideMappings[selectorIndex];
    
    //Game and Practice Mode handling
    if (refCode.current !== undefined && indexRefCode.current !== undefined) {

      //If correct hit
      if (refCode.current[indexRefCode.current] === selectorIndex) {
        //Start the timer after the first successful hit
        if (indexRefCode.current === 0) {
          timerDotStart.current = performance.now();
        }
        
        goodDotHits.current++;
        indexRefCode.current++;
        wordSubstringer.current++;
      
        //if the correct hit is a SPACE
        if (codeChar === " " && sentence.current !== undefined && indexSentence.current !== undefined) {
          //Append to the words and refresh code
          theWords.current = [...theWords.current, sentence.current[indexSentence.current],];
          code.current = "";

          //Move to the next word
          wordSubstringer.current = 0;
          indexSentence.current += 1;

          //If its your last word
          if (indexSentence.current === sentence.current.length) {;
            timeDotLength.current = performance.now() - (timerDotStart.current ?? 0);
            
            //Calculate values
            dotCcpm.current = (goodDotHits.current / timeDotLength.current) * 60000;
            accuracy.current = goodDotHits.current / (goodDotHits.current + badDotHits.current);

            //Add to the leaderboard
            leederboredVals.current.push({
              player: "borg",
              ccpm: dotCcpm.current,
              accuracy: accuracy.current
            });

            stopPracticeMode();
          }
        }
        
        
        new Audio("coin2.mp3")
          .play()
          .catch((error) =>
            console.error("Error playing audio:", error),
          );
      } else { //if incorrect hit
        badDotHits.current++;
        new Audio("erro.mp3")
          .play()
          .catch((error) =>
            console.error("Error playing audio:", error),
          );
      }
      
    }

    
    // If side 3 => space => finalize
    if (codeChar === " ") {
      if (
        !refCode.current && //if not in game or practice mode
        !inLights.current &&
        activePage.current == OctagonPage.Keyboard
      ) {
        finalizeCurrentWord();
      }

      /* Backspace: Only allow in keyboard mode */
    } else if (
      codeChar === "⌫" &&
      activePage.current === OctagonPage.Keyboard &&
      !pageChangeOccured
    ) {
      if (code.current) {
        console.log("trying to remove just the last letter");
        code.current = code.current.substring(0, code.current.length - 1);
      } else {
        theWords.current.pop();
        theCodes.current.pop();
      }

      /* Standard typing case: append code character */
    } else if (
      codeChar &&
      !inLights.current &&
      activePage.current == OctagonPage.Keyboard &&
      !pageChangeOccured
    ) {
      // Add digit to typedCodes
      code.current = code.current + codeChar;
      console.log(code.current);
    }
  }

  /*
   * Render typing
   *
   */
  function renderTyping() {}

  //Leaderboard jawns

  interface LeaderboardEntry {
    player: string;
    ccpm: number;
    accuracy?: number;
  }
  const leederboredVals = useRef<LeaderboardEntry[]>([
    { player: "easy E", ccpm: 52.02 },
    { player: "little B", ccpm: 55.69 },
    { player: "nata C", ccpm: 66.22 },
  ]);

  const sortedLeaderboard = leederboredVals.current
    .slice() // Create a shallow copy to avoid mutating the original
    .sort((a, b) => b.ccpm - a.ccpm); // Sort in descending order based on CCPM

  // Animate
  useEffect(() => {
    const animation = requestAnimationFrame(drawScene);
    return () => cancelAnimationFrame(animation);
  }, [drawScene]);

  const [videoVisible, setVideoVisible] = useState(true);
  const [videoOpacity, setVideoOpacity] = useState(0);
  //useless edit

  const isPlaying = useRef<boolean>(false);
  const yts = [
    "ekr2nIex040",
    "VCTOpdlZJ8U",
    "Tv94swj4sjo",
    "9Vnbsuny2LI",
    "dvgZkm1xWPE",
    "9Y8OA70vmeY",
    "YUuE2D6MwS8",
    "Ux5AiKmra-E",
    "hucCiV_CNN0",
    "fJ9rUzIMcZQ",
    "A_MjCqQoLLA",
    "V1bFr2SWP1I",
    "yKNxeF4KMsY",
    "TGkMYMxi-hw",
    "e_AZJzYe7CU",
    "8twpQTna_9w",
    "jECXQ57vW7g",
    "8al5cSQNmME",
    "eBf4s0HfgjQ",
    "ZqW_5Ka0n7g",
    "YOJsKatW-Ts",
    "-NuX79Ud8zI",
    "CHXfuGXM1Gg",
    "eyI635o2pmk",
  ];
  const randomyt = useRef<string>();

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
      {/* Video Overlay */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 1000,
          opacity: videoOpacity,
          transition: "opacity 0.5s ease-in-out",
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          width: "600px", // Increased size for larger circle
          height: "600px", // Should be equal to width for perfect circle
          borderRadius: "50%", // Adjusted for larger circle
          overflow: "hidden",
          pointerEvents: videoVisible ? "auto" : "none",
          display: "flex",
          justifyContent: "center", // Center the video horizontally
          alignItems: "center", // Center the video vertically
        }}
      >
        {/*<iframe
          width="560"
          height="315"
          src={`https://www.youtube.com/embed/${randomyt.current}?controls=0&loop=1&autoplay=${isPlaying.current ? 1 : 0}`}
          title="YouTube video player"
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />*/}
      </div>
      {/* Leaderboard Section */}
      <div
        style={{
          position: "fixed",
          bottom: "100px", // Adjust the distance from the bottom as needed
          left: "20px",
          backgroundColor: "rgba(0, 42, 0, 0.7)",
          padding: "20px",
          color: "white",
          zIndex: 999,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 44 }}>Leaderboard</h3>
        <div style={{ display: "flex", gap: "23px" }}>
          <div>
            {sortedLeaderboard.map((_, index) => (
              <div key={index} style={{ fontSize: "23px" }}>
                #{index + 1}
              </div>
            ))}{" "}
          </div>
          <div>
            {sortedLeaderboard.map((entry, index) => (
              <div key={index} style={{ fontSize: "23px" }}>
                {entry.player}
              </div>
            ))}
          </div>
          <div>
            {sortedLeaderboard.map((entry, index) => (
              <div key={index} style={{ fontSize: "23px" }}>
                {Math.round(entry.ccpm) + " CPM"}
              </div>
            ))}{" "}
          </div>
          <div>
            {sortedLeaderboard.map((entry, index) => (
              <div key={index} style={{ fontSize: "23px" }}>
                {entry.accuracy ? Math.round(entry.accuracy * 100) + "%" : "100%"}
              </div>
            ))}{" "}
          </div>
        </div>
      </div>
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
            zIndex: 1000000,
          }}
          onClick={(e) => {
            inDiagnostics.current = false;
          }}
        >
          Octagon
        </button>

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
            inDiagnostics.current = true;
          }}
        >
          Magic Dots
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
        style={{ 
          position: "fixed", bottom: 0, left: 0, padding: "5px 10px" }}
      >
        <button
          onClick={() => {
            renderCursorTrail.current = !renderCursorTrail.current;
          }}
          style={{
            backgroundColor: "#555555", // Off-black button background
            color: "white", // White text
            border: "none",
            borderRadius: "5px",
            padding: "5px 15px",
            cursor: "pointer",
            zIndex: 1000000,
          }}
        >
          Cursor Trail: {renderCursorTrail.current ? "On" : "Off"}
        </button>

        <button
          onClick={() => {
            dwellClickMode.current = !dwellClickMode.current;
          }}
          style={{
            backgroundColor: "#555555", // Off-black button background
            color: "white", // White text
            border: "none",
            borderRadius: "5px",
            padding: "5px 15px",
            cursor: "pointer",
            zIndex: 1000000,
          }}
        >
          Dwell Click: {dwellClickMode.current ? "On" : "Off"}
        </button>

        <button
          onClick={() => {
            switch (dwellZoneRendering.current) {
              case DwellZoneRendering.OnHover:
                dwellZoneRendering.current = DwellZoneRendering.Never;
                break;
              case DwellZoneRendering.Never:
                dwellZoneRendering.current = DwellZoneRendering.Visible;
                break;
              case DwellZoneRendering.Visible:
                dwellZoneRendering.current = DwellZoneRendering.OnHover;
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
            zIndex: 1000000,
          }}
        >
          Dwell Rendering: {dwellZoneRendering.current}
        </button>

        <input
          id="dwell-zone-slider"
          type="range"
          min={0}
          max={radiusOct}
          step="5"
          value={dwellZoneRadius.current}
          onChange={(e) =>
            (dwellZoneRadius.current = parseFloat(e.target.value))
          }
          style={{
            width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            height: "10px", // Custom track height
            outline: "none", // Removes outline on focus
          }}
        />

        <label htmlFor="dwell-duration">dwell dur ms </label>
        <input
          id="dwell-duration"
          type="number"
          min={0}
          max={5000}
          step="50"
          value={dwellDurationMs.current}
          onChange={(e) =>
            (dwellDurationMs.current = parseFloat(e.target.value))
          }
          style={{
            // width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            outline: "none", // Removes outline on focus
          }}
        />

        <label htmlFor="dwell-click-threshold">dwell click ms </label>
        <input
          id="dwell-click-threshold"
          type="number"
          min={0}
          max={300}
          step="25"
          value={dwellClickThreshold.current}
          onChange={(e) =>
            (dwellClickThreshold.current = parseFloat(e.target.value))
          }
          style={{
            // width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            outline: "none", // Removes outline on focus
          }}
        />

        <label htmlFor="dwell-time">dwell time </label>
        <input
          id="dwell-time"
          type="number"
          min={0}
          max={1000}
          step="50"
          value={dwellTimeRequired.current}
          onChange={(e) =>
            (dwellTimeRequired.current = parseFloat(e.target.value))
          }
          style={{
            // width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            outline: "none", // Removes outline on focus
          }}
        />

        <label htmlFor="fast-threshold">fast </label>
        <input
          id="fast-threshold"
          type="number"
          min={0}
          max={20000}
          step="200"
          value={fastThreshold.current}
          onChange={(e) => (fastThreshold.current = parseFloat(e.target.value))}
          style={{
            // width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            outline: "none", // Removes outline on focus
          }}
        />

        <label htmlFor="Multiplier">Multiplier </label>
        <input
          id="multiplier"
          type="number"
          min={0.1}
          max={4}
          step="0.1"
          value={multiplier.current}
          onChange={(e) => (multiplier.current = parseFloat(e.target.value))}
          style={{
            // width: "150px",
            appearance: "none", // Removes default slider styles
            background: "#333333", // Off-black background for the slider track
            borderRadius: "5px",
            outline: "none", // Removes outline on focus
          }}
        />

      <label htmlFor="DwellBrick">Brick Dwell Time </label>
        <input
          id="DwellBrick"
          type="number"
          min={0}
          max={2000}
          step="50"
          value={dwellBrickTime.current}
          onChange={(e) => (dwellBrickTime.current = parseFloat(e.target.value))}
          style={{
            height: "80px", // Increased height
            fontSize: "20px", // Larger font size
            padding: "5px 10px", // Added padding
            appearance: "none",
            background: "#333333",
            borderRadius: "5px",
            outline: "none",
            color: "white", // Added for better visibility
            marginRight: "20px", // Added spacing between elements
          }}
        />

      <label htmlFor="DwellBrick">Brick Refraction Time </label>
        <input
          id="DwellBrickRefractory"
          type="number"
          min={0}
          max={2000}
          step="50"
          value={dwellBrickRefractory.current}
          onChange={(e) => (dwellBrickRefractory.current = parseFloat(e.target.value))}
          style={{
            height: "80px", // Increased height
            fontSize: "20px", // Larger font size
            padding: "5px 10px", // Added padding
            appearance: "none",
            background: "#333333",
            borderRadius: "5px",
            outline: "none",
            color: "white", // Added for better visibility
            marginRight: "20px", // Added spacing between elements
          }}
        />
      </div>

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
        {/* Display Velocity Values */}
        <div
          style={{
            fontSize: "12px",
            color: "rgba(255, 255, 255, 0.5)", // Semi-transparent white for discreet display
            marginBottom: "5px",
          }}
        >
          Vx: {(velocities.current?.final_velocity_x ?? 0).toFixed(2)}, Vy:{" "}
          {(velocities.current?.final_velocity_y ?? 0).toFixed(2)}
        </div>
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
        height={1200}
        style={{
          border: "1px dotted purple",
          marginTop: "100px", // Adjust this value as needed
          position: "relative", // Add this
          // zIndex: 2000,         // Higher than video overlay
          opacity: 1, // Ensure canvas is fully opaque
          pointerEvents: systemCursorEnabled ? "auto" : "none",
          zIndex: 0,
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

      {/* New Buttons Row */}
      <div
        style={{
          display: "flex",
          flexDirection: "row", // Align buttons horizontally
          gap: "10px", // Space between buttons
        }}
      >
        {[...Array(9)].map((_, index) => (
          <button
            key={index}
            style={{
              width: "50px",
              height: "50px",
              backgroundColor: "black", // Black background
              border: "2px solid white",
              borderRadius: "5px",
              cursor: "pointer",
            }}
            onClick={() => {
              switch (index) {
                case 0:
                  // Action for the first button
                  showCursor.current = !showCursor.current;
                  console.log(
                    `Cursor is now ${showCursor.current ? "On" : "Off"}`,
                  );
                  break;
                case 1:
                  speakWords();
                  break;

                case 2:
                  theWords.current = [];
                  theCodes.current = [];
                  dirtyWords.current = [];
                  code.current = "";
                  break;

                case 3:
                  inDotPractice.current = true;
                  inDiagnostics.current = true;
                  dotGameMode.current = true;
                  indexGameDot.current = 0;

                  goodDotHits.current = 0;
                  badDotHits.current = 0;
                  accuracy.current = undefined;

                  timerDotStart.current = undefined;
                  timeDotLength.current = undefined;

                  dotCcpm.current = undefined;

                  startPracticeMode();
                  break;

                case 4:
                  // Action for the fourth button
                  snapBackMode.current = !snapBackMode.current;
                  break;

                case 6:
                  inDotPractice.current = true;
                  // Action for the fourth button
                  inDiagnostics.current = true;

                  goodDotHits.current = 0;
                  badDotHits.current = 0;
                  accuracy.current = undefined;

                  timerDotStart.current = undefined;
                  timeDotLength.current = undefined;

                  dotCcpm.current = undefined;

                  startPracticeMode();

                  break;

                case 7:
                  inDotPractice.current = true;
                  inDiagnostics.current = true;

                  goodDotHits.current = 0;
                  badDotHits.current = 0;
                  accuracy.current = undefined;
                  break;

                case 8:
                  inDotPractice.current = true;
                  inDiagnostics.current = true;
                  dotArrowMode.current = true;

                  goodDotHits.current = 0;
                  badDotHits.current = 0;
                  accuracy.current = undefined;

                  timerDotStart.current = undefined;
                  timeDotLength.current = undefined;

                  dotCcpm.current = undefined;

                  startPracticeMode();

                  break;

                default:
                  break;
              }
            }}
          >
            {(() => {
              switch (index) {
                case 1:
                  return "🗣️";
                case 2:
                  return "🗑️";
                case 3:
                  return "Game";
                case 4:
                  return snapBackMode.current ? "snap: on" : "snap: off";
                case 6:
                  return "train";
                case 7:
                  return "type";
                case 8:
                  return "arrow";
              }
            })()}
          </button>
        ))}
      </div>
    </div>
  );
};

export default PointerLockWrapper;
