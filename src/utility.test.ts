import { getUsernameFromUrl } from "./utility.js";

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
