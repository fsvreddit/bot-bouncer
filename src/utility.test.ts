import { getUsernameFromUrl, median } from "./utility.js";

test("URL parsing", () => {
    const expected = [
        { input: "https://www.reddit.com/user/spez/", result: "spez" },
        { input: "https://www.reddit.com/u/spez", result: "spez" },
        { input: "https://www.reddit.com/u/spez/", result: "spez" },
        { input: "https://www.reddit.com/user/spez", result: "spez" },
        { input: "https://new.reddit.com/user/spez", result: "spez" },
        { input: "https://old.reddit.com/user/spez", result: "spez" },
        { input: "https://sh.reddit.com/user/spez/", result: "spez" },
        { input: "https://www.reddit.com/user/spez/overview/", result: "spez" },
        { input: "https://www.reddit.com/user/spez/comments/", result: "spez" },
        { input: "https://www.reddit.com/user/spez/submitted/", result: "spez" },
        { input: "reddit.com/user/spez", result: "spez" },
        { input: "https://www.reddit.com/user/spez/?utm_source=abc", result: "spez" },
        { input: "https://old.reddit.com/r/fsvapps/comments/166g88j/introducing_hive_protector/", result: undefined },
        { input: "https://www.bbc.co.uk/news/articles/cwygw982e3xo", result: undefined },
    ];

    const actual = expected.map(item => ({ input: item.input, result: getUsernameFromUrl(item.input) }));

    expect(actual).toEqual(expected);
});

test("Median with one input", () => {
    const input = [1];
    const expected = 1;
    const actual = median(input);
    expect(actual).toEqual(expected);
});

test("Median with odd numbers of inputs", () => {
    const input = [1, 2, 100];
    const expected = 2;
    const actual = median(input);
    expect(actual).toEqual(expected);
});

test("Median with even numbers of inputs", () => {
    const input = [1, 2, 3, 100];
    const expected = 2.5;
    const actual = median(input);
    expect(actual).toEqual(expected);
});
