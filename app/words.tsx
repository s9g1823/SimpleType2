export type Tree = Record<string, any>;
export type WordFrequency = Record<string, number>;

export function allWords(tree: Tree, parent: string): string[] {
    if (parent === "#") {
        return tree as string[];
    }
    if (!tree) {
        return [];
    }
    return Object.entries(tree).reduce((acc, [key, value]) => {
        acc.push(...allWords(value, key));
        return acc;
    }, [] as string[]);
};

export function getSubtree(codeword: string, tree: Tree | string[]): Tree | string[] {
    let subtree: Tree | string[] = tree;

    for (const char of codeword) {
        if (!subtree || typeof subtree !== "object" || !(char in subtree)) {
            return [];
        }
        subtree = (subtree as Record<string, any>)[char];
    }
    return subtree;
};

export function orderByMostFrequent(words: string[], freq: WordFrequency): string[] {
    return words.sort((a, b) => (freq[b] || 0) - (freq[a] || 0));
};

export function getRankedMatches(
    context: string[],
    code: string,
    tree: Tree,
    ngrams: Record<string, number>,
    freq: WordFrequency,
    precomputed: Record<string, string[]>,
): string[] {

    const possibleWords = code.length === 1
        ? precomputed[code]
        : orderByMostFrequent(allWords(getSubtree(code, tree), ""), freq);

    if (!context.length) {
        console.log("High ranked choices are: ", possibleWords.slice(0, 5));
        return possibleWords.slice(0, 5); // Return top 5 immediately if no context
    }

    // Take last 2 context words to use from the back since this is a trigram.
    const contextString = context.slice(-2).join(" ") + " ";
    console.log("context is: ", contextString);
    const matchingTrigrams = Object.entries(ngrams).filter(([key]) =>
        key.startsWith(contextString)
    );

    // Sort matching ngrams directly by their frequency
    const matches = matchingTrigrams
        .sort(([, freqA], [, freqB]) => freqB - freqA)
        .map(([gram]) => gram.replace(contextString, ""))
        .slice(0, 500);
        // .slice(0);

    const nextWords =
        context.length === 1
            ? matches.map((word) => word.split(" ")[0])
            : matches;

    const possibleWordsSet = new Set(possibleWords);
    // console.log("possibleWordsSet is: ", possibleWordsSet);
    // console.log("nextWordsSet is: ", nextWords);
    let choices = nextWords.filter((word) => possibleWordsSet.has(word)).slice(0, 5);

    // If there are no choices by ngram ordering, then just provide some of the
    // top possible words.
    if (choices.length === 0) {
        choices = Array.from(possibleWordsSet).slice(0, 15);
    }

    // Additional words that match code length but aren't in choices
    const additionalWords = possibleWords.filter(
        (word) => word.length === code.length && !choices.includes(word)
    );

    console.log("High ranked choices are: ", choices);
    console.log("Other words are: ", additionalWords);
    return [...new Set([...choices, ...additionalWords])];
}

