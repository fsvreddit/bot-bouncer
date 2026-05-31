import { conditionallyCompressString, conditionallyDecompressString, getUsernameFromUrl, median, sendMessageToWebhook, updateWebhookMessage } from "./utility.js";

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

test("Conditionally compress and decompress string", () => {
    const input = "a".repeat(10000);
    const compressed = conditionallyCompressString(input);
    const decompressed = conditionallyDecompressString(compressed);
    expect(decompressed).toEqual(input);
    expect(compressed).not.toEqual(input);
});

test("Conditionally compress and decompress string that is not large enough to compress", () => {
    const input = "This is a short string.";
    const compressed = conditionallyCompressString(input);
    const decompressed = conditionallyDecompressString(compressed);
    expect(decompressed).toEqual(input);
    expect(compressed).toEqual(input);
});

test("sendMessageToWebhook returns message id when webhook responds successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        // eslint-disable-next-line @typescript-eslint/require-await
        json: async () => ({ id: "abc123" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const messageId = await sendMessageToWebhook("https://example.com/webhook", "hello");

    expect(messageId).toBe("abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
});

test("sendMessageToWebhook returns undefined when webhook responds with failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        // eslint-disable-next-line @typescript-eslint/require-await
        text: async () => "server error",
    });

    vi.stubGlobal("fetch", fetchMock);

    const messageId = await sendMessageToWebhook("https://example.com/webhook", "hello");

    expect(messageId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
});

test("updateWebhookMessage returns true on success and false on failure", async () => {
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        // eslint-disable-next-line @typescript-eslint/require-await
        .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not found" });

    vi.stubGlobal("fetch", fetchMock);

    const success = await updateWebhookMessage("https://example.com/webhook", "message-1", "updated");
    const failure = await updateWebhookMessage("https://example.com/webhook", "message-2", "updated");

    expect(success).toBe(true);
    expect(failure).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
});
