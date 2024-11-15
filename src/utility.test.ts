import { getUsernameFromUrl } from "./utility.js";

test("URL parsing", () => {
    const inputs = [
        "https://www.reddit.com/user/spez/",
        "https://www.reddit.com/u/spez",
        "https://www.reddit.com/u/spez/",
        "https://www.reddit.com/user/spez",
        "https://sh.reddit.com/user/spez/",
        "reddit.com/user/spez",
        "https://www.reddit.com/user/spez/?utm_source=abc",
    ];

    const expected = inputs.map(input => ({ input, result: "spez" }));
    const actual = inputs.map(input => ({ input, result: getUsernameFromUrl(input) }));

    expect(actual).toEqual(expected);
});
