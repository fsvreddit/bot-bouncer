import { getUsernameFromUrl } from "./utility.js";

test("URL parsing", () => {
    const expected = "spez";

    const inputs = [
        "https://www.reddit.com/user/spez/",
        "https://www.reddit.com/u/spez",
        "https://www.reddit.com/u/spez/",
        "https://www.reddit.com/user/spez",
        "https://sh.reddit.com/user/spez/",
        "reddit.com/user/spez",
        "https://www.reddit.com/user/spez/?utm_source=abc",
    ];

    for (const input of inputs) {
        const username = getUsernameFromUrl(input);
        expect(username).toEqual(expected);
    }
});
