import axios from "axios";

export type Tree = Record<string, any>;
export type WordFrequency = Record<string, number>;

export function allWords(tree: Tree, parent: string): string[] {
  if (parent === "#") {
    return tree as string[];
  }

  if (!tree) {
    return [];
  }

  const result: string[] = [];

  for (const key in tree) {
    const childWords = allWords(tree[key], key);
    for (let i = 0; i < childWords.length; i++) {
      result.push(childWords[i]);
    }
  }

  return result;
}

export function allWordsForCode(tree: Tree, code: string): string[] {
  // Returns exact matches for the provided code
  let node: any = tree;
  for (const char of code) {
    if (!node[char]) {
      return [];
    }
    node = node[char];
  }

  // NOTE: These are already ordered by most frequent
  return node["#"] ?? [];
}

export function getSubtree(
  codeword: string,
  tree: Tree | string[],
): Tree | string[] {
  let subtree: Tree | string[] = tree;

  for (const char of codeword) {
    if (!subtree || typeof subtree !== "object" || !(char in subtree)) {
      return [];
    }
    subtree = (subtree as Record<string, any>)[char];
  }
  return subtree;
}

export function orderByMostFrequent(
  words: string[],
  freq: WordFrequency,
): string[] {
  return words.sort((a, b) => (freq[b] || 0) - (freq[a] || 0));
}

export function getRankedMatches(
  context: string[],
  code: string,
  tree: Tree,
  ngrams: Record<string, number>,
  freq: WordFrequency,
  precomputed: Record<string, string[]>,
  useTree: boolean,
): string[] {

  let possibleWords = [];
  if (useTree) {
    possibleWords =
      code.length === 1
        ? precomputed[code]
        : orderByMostFrequent(allWords(getSubtree(code, tree), ""), freq);
  } else {
      possibleWords = orderByMostFrequent(allWordsForCode(tree, code), freq);
  }

  if (!context.length) {
    console.log("High ranked choices are: ", possibleWords.slice(0, 5));
    return possibleWords.slice(0, 5); // Return top 5 immediately if no context
  }

  // Take last 2 context words to use from the back since this is a trigram.
  const contextString = context.slice(-2).join(" ") + " ";
  console.log("context is: ", contextString);

  const matchingTrigrams: Array<[string, number]> = [];
  for (const key in ngrams) {
    if (key.startsWith(contextString)) {
      matchingTrigrams.push([key, ngrams[key]]);
    }
  }

  // Sort matching ngrams directly by their frequency
  const matches = matchingTrigrams
    .sort(([, freqA], [, freqB]) => freqB - freqA)
    .map(([gram]) => gram.replace(contextString, ""))
    .slice(0, 500);
  // .slice(0);

  const nextWords =
    context.length === 1 ? matches.map((word) => word.split(" ")[0]) : matches;

  const possibleWordsSet = new Set(possibleWords);
  // console.log("possibleWordsSet is: ", possibleWordsSet);
  // console.log("nextWordsSet is: ", nextWords);
  let choices = nextWords
    .filter((word) => possibleWordsSet.has(word))
    .slice(0, 5);

  // If there are no choices by ngram ordering, then just provide some of the
  // top possible words.
  if (choices.length === 0) {
    choices = Array.from(possibleWordsSet).slice(0, 15);
  }

  // Additional words that match code length but aren't in choices
  const additionalWords = possibleWords.filter(
    (word) => word.length === code.length && !choices.includes(word),
  );

  // console.log("High ranked choices are: ", choices);
  // console.log("Other words are: ", additionalWords);
  return [...new Set([...choices, ...additionalWords])];
}

export async function pickWordViaGPT(candidatesFiltered: string[], daWords: string[]): Promise<string> {
    console.log("GPT is running with candidates: " + candidatesFiltered);
    console.log("GPT is running with the words: " + daWords);
    if (!candidatesFiltered || candidatesFiltered.length === 0) {
      return "";
    }
    const prompt = `
     Someone is typing a sentence very slowly. You want to guess the next word.

     Here are the words in the sentence so far:
     ${daWords.join(", ")}

     Pick one word from below that is the most likely next word based on what makes sense and what is a more common word:
     {${candidatesFiltered.join(", ")}}


     Output your top 5 predictions guess for the next word. No quotes, no explanation.
     Only write the top 5 words, one on each line.
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
      // return response.data.choices[0].message.content.trim();
      const outputText = response.data.choices[0].message.content.trim();
      const top5Predictions = outputText.split("\n").slice(0, 5);

      return top5Predictions;

    } catch (error) {
      console.log("GPT didn't work for some random reason" + error);
      return candidatesFiltered[0];
    }
}
