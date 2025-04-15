/* eslint-disable no-return-assign */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
/*
This code is taken from difflib-ts: https://www.npmjs.com/package/difflib-ts

Then simplified, cleaned and fixed up so that it works in a Devvit environment.

Parts of difflib-ts that I do not use have been removed from the solution.
*/

type JunkOption = ((x: string) => boolean);

// Helper functions
function _calculateRatio (matches: number, length: number) {
    if (length) {
        return 2.0 * matches / length;
    } else {
        return 1.0;
    }
}

function _arrayCmp (a: number[], b: number[]) {
    const la = a.length;
    const lb = b.length;
    for (let i = 0, end = Math.min(la, lb), asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
        if (a[i] < b[i]) {
            return -1;
        }
        if (a[i] > b[i]) {
            return 1;
        }
    }
    return la - lb;
}

function _has (obj: Record<string | number | symbol, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * SequenceMatcher is a flexible class for comparing pairs of sequences of
 * any type, so long as the sequence elements are hashable.  The basic
 * algorithm predates, and is a little fancier than, an algorithm
 * published in the late 1980's by Ratcliff and Obershelp under the
 * hyperbolic name "gestalt pattern matching".
 *
 * The basic idea is to find
 * the longest contiguous matching subsequence that contains no "junk"
 * elements (R-O doesn't address junk).  The same idea is then applied
 * recursively to the pieces of the sequences to the left and to the right
 * of the matching subsequence.  This does not yield minimal edit
 * sequences, but does tend to yield matches that "look right" to people.
 * SequenceMatcher tries to compute a "human-friendly diff" between two
 * sequences.  Unlike e.g. UNIX(tm) diff, the fundamental notion is the
 * longest *contiguous* & junk-free matching subsequence.  That's what
 * catches peoples' eyes.  The Windows(tm) windiff has another interesting
 * notion, pairing up elements that appear uniquely in each sequence.
 * That, and the method here, appear to yield more intuitive difference
 * reports than does diff.  This method appears to be the least vulnerable
 * to synching up on blocks of "junk lines", though (like blank lines in
 * ordinary text files, or maybe "<P>" lines in HTML files).  That may be
 * because this is the only method of the 3 that has a *concept* of
 * "junk" <wink>.
 *
 * @example
 * // Example, comparing two strings, and considering blanks to be "junk":
 * isjunk = (c) -> c is ' '
 * s = new SequenceMatcher(isjunk,
 * 'private Thread currentThread;',
 * 'private volatile Thread currentThread;')
 * // .ratio() returns a float in [0, 1], measuring the "similarity" of the
 * // sequences.  As a rule of thumb, a .ratio() value over 0.6 means the
 * // sequences are close matches:
 * s.ratio().toPrecision(3) // '0.866'
 *
 * // If you're only interested in where the sequences match,
 * // .getMatchingBlocks() is handy:
 * for [a, b, size] in s.getMatchingBlocks()
 * console.log("a[#{a}] and b[#{b}] match for #{size} elements");
 * // a[0] and b[0] match for 8 elements
 * // a[8] and b[17] match for 21 elements
 * // a[29] and b[38] match for 0 elements
 *
 * // Note that the last tuple returned by .get_matching_blocks() is always a
 * // dummy, (len(a), len(b), 0), and this is the only case in which the last
 * // tuple element (number of elements matched) is 0.
 * // If you want to know how to change the first sequence into the second,
 * // use .get_opcodes():
 * for [op, a1, a2, b1, b2] in s.getOpcodes()
 * console.log "#{op} a[#{a1}:#{a2}] b[#{b1}:#{b2}]"
 * // equal a[0:8] b[0:8]
 * // insert a[8:8] b[8:17]
 * // equal a[8:29] b[17:38]
 */
export class SequenceMatcher {
    /**
   * first sequence
   */
    a = "";

    /**
   * second sequence differences are computed as
   * "what do we need to do to 'a' to change it into 'b'?"
   */
    b = "";

    /**
   * for x in b, b2j[x] is a list of the indices (into b)
   * at which x appears; junk elements do not appear
   */
    b2j!: Record<string, number[]>;

    /**
   * for x in b, fullbcount[x] == the number of times x
   * appears in b; only materialized if really needed (used
   * only for computing quickRatio())
   */
    fullbcount!: Record<string, number> | null;

    /**
   * a list of [i, j, k] triples, where a[i...i+k] == b[j...j+k];
   * ascending & non-overlapping in i and in j; terminated by
   * a dummy (len(a), len(b), 0) sentinel
   */
    matchingBlocks!: number[][] | null;

    /**
   * a user-supplied function taking a sequence element and
   * returning true iff the element is "junk" -- this has
   * subtle but helpful effects on the algorithm, which I'll
   * get around to writing up someday <0.9 wink>.
   * DON'T USE!  Only __chainB uses this.  Use isbjunk.
   */
    isjunk!: JunkOption;

    /**
   * for x in b, isbjunk(x) == isjunk(x) but much faster;
   * DOES NOT WORK for x in a!
   */
    isbjunk!: JunkOption;

    /**
   * for x in b, isbpopular(x) is true if b is reasonably long
   * (at least 200 elements) and x accounts for more than 1 + 1% of
   * its elements (when autojunk is enabled).
   * DOES NOT WORK for x in a!
   */
    isbpopular!: JunkOption;

    /**
   * "automatic junk heuristic" that treats popular elements as junk
   */
    autojunk = true;

    /**
   * Construct a SequenceMatcher.
   *
   * @param isjunk - null by default, or a one-argument
   * function that takes a sequence element and returns true if the
   * element is junk.  null is equivalent to passing `(x) => 0`, i.e.
   * no elements are considered to be junk.
   *
   * For example, pass `(x) -> x in ' \t'`
   * if you're comparing lines as sequences of characters, and don't
   * want to sync up on blanks or hard tabs.
   *
   * @param a - the first of two sequences to be compared.  By
   * default, an empty string.  The elements of `a` must be hashable.  See
   * also `.setSeqs()` and `.setSeq1()`.
   *
   * @param b - the second of two sequences to be compared.  By
   * default, an empty string.  The elements of `b` must be hashable. See
   * also `.setSeqs()` and `.setSeq2()`.
   *
   * @param autojunk - should be set to false to disable the
   * "automatic junk heuristic" that treats popular elements as junk
   * (see module documentation for more information).
   */
    constructor (
        isjunk?: JunkOption | null,
        a?: string,
        b?: string,
        autojunk?: boolean,
    ) {
        if (isjunk != null) {
            this.isjunk = isjunk;
        }
        if (a == null) {
            a = "";
        }
        if (b == null) {
            b = "";
        }
        if (autojunk == null) {
            autojunk = true;
        }
        this.autojunk = autojunk;
        this.setSeqs(a, b);
    }

    /**
   * Set the two sequences to be compared.
   * @example
   * const s = new SequenceMatcher()
   * s.setSeqs('abcd', 'bcde')
   * s.ratio() // 0.75
   */
    setSeqs (a: string, b: string) {
        this.setSeq1(a);
        this.setSeq2(b);
    }

    /**
   * Set the first sequence to be compared.
   *
   * The second sequence to be compared is not changed.
   *
   * @example
   * const s = new SequenceMatcher(null, 'abcd', 'bcde')
   * s.ratio() // 0.75
   *
   * s.setSeq1('bcde')
   * s.ratio() // 1.0
   *
   * @remark
   * SequenceMatcher computes and caches detailed information about the
   * second sequence, so if you want to compare one sequence S against
   * many sequences, use `.setSeq2(S)` once and call `.setSeq1(x)`
   * repeatedly for each of the other sequences.
   * See also `setSeqs()` and `setSeq2()`.
   */
    setSeq1 (a: string) {
        if (a === this.a) {
            return;
        }
        this.a = a;
        this.matchingBlocks = null;
    }

    /**
   * Set the second sequence to be compared.
   *
   * The first sequence to be compared is not changed.
   *
   * @example
   * const s = new SequenceMatcher(null, 'abcd', 'bcde')
   * s.ratio() // 0.75
   *
   * s.setSeq2('abcd')
   * s.ratio() // 1.0
   *
   * @remark
   * SequenceMatcher computes and caches detailed information about the
   * second sequence, so if you want to compare one sequence S against
   * many sequences, use `.setSeq2(S)` once and call `.setSeq1(x)`
   * repeatedly for each of the other sequences.
   * See also `setSeqs()` and `setSeq1()`.
   */
    setSeq2 (b: string) {
        if (b === this.b) {
            return;
        }
        this.b = b;
        this.matchingBlocks = null;
        this.fullbcount = null;
        this._chainB();
    }

    // For each element x in b, set b2j[x] to a list of the indices in
    // b where x appears; the indices are in increasing order; note that
    // the number of times x appears in b is b2j[x].length ...
    // when @isjunk is defined, junk elements don't show up in this
    // map at all, which stops the central findLongestMatch method
    // from starting any matching block at a junk element ...
    // also creates the fast isbjunk function ...
    // b2j also does not contain entries for "popular" elements, meaning
    // elements that account for more than 1 + 1% of the total elements, and
    // when the sequence is reasonably large (>= 200 elements); this can
    // be viewed as an adaptive notion of semi-junk, and yields an enormous
    // speedup when, e.g., comparing program files with hundreds of
    // instances of "return null;" ...
    // note that this is only called when b changes; so for cross-product
    // kinds of matches, it's best to call setSeq2 once, then setSeq1
    // repeatedly

    _chainB () {
    // Because isjunk is a user-defined function, and we test
    // for junk a LOT, it's important to minimize the number of calls.
    // Before the tricks described here, __chainB was by far the most
    // time-consuming routine in the whole module!  If anyone sees
    // Jim Roskind, thank him again for profile.py -- I never would
    // have guessed that.
    // The first trick is to build b2j ignoring the possibility
    // of junk.  I.e., we don't call isjunk at all yet.  Throwing
    // out the junk later is much cheaper than building b2j "right"
    // from the start.
        let b2j: Record<string, number[]>, indices: number[];
        const { b } = this;
        this.b2j = b2j = {};

        for (let i = 0; i < b.length; i++) {
            const elt = b[i];
            indices = _has(b2j, elt) ? b2j[elt] : b2j[elt] = [];
            indices.push(i);
        }

        // Purge junk elements
        const junk: Record<string, boolean> = {};
        const { isjunk } = this;
        if (isjunk) {
            for (const elt of Object.keys(b2j)) {
                if (isjunk(elt)) {
                    junk[elt] = true;
                    delete b2j[elt];
                }
            }
        }

        // Purge popular elements that are not junk
        const popular: Record<string, boolean> = {};
        const n = b.length;
        if (this.autojunk && n >= 200) {
            const ntest = Math.floor(n / 100) + 1;
            for (const elt of Object.keys(b2j)) {
                const idxs = b2j[elt];
                if (idxs.length > ntest) {
                    popular[elt] = true;
                    delete b2j[elt];
                }
            }
        }

        // Now for x in b, isjunk(x) == x in junk, but the latter is much faster.
        // Sicne the number of *unique* junk elements is probably small, the
        // memory burden of keeping this set alive is likely trivial compared to
        // the size of b2j.
        this.isbjunk = (b: string) => _has(junk, b);
        this.isbpopular = (b: string) => _has(popular, b);
    }

    /**
   * Find longest matching block in a[alo...ahi] and b[blo...bhi].
   *
   * @remarks If isjunk is not defined:
   *
   * Return [i,j,k] such that a[i...i+k] is equal to b[j...j+k], where
   *
   * alo <= i <= i+k <= ahi
   *
   * blo <= j <= j+k <= bhi
   *
   * and for all [i',j',k'] meeting those conditions,
   *
   * k >= k'
   *
   * i <= i'
   *
   * and if i == i', j <= j'
   *
   * In other words, of all maximal matching blocks, return one that
   * starts earliest in a, and of all those maximal matching blocks that
   * start earliest in a, return the one that starts earliest in b.
   *
   * @example
   * isjunk = (x) => x // is ' '
   * const s = new SequenceMatcher(isjunk, ' abcd', 'abcd abcd')
   * s.findLongestMatch(0, 5, 0, 9) // [1, 0, 4]
   *
   * const s = new SequenceMatcher(null, 'ab', 'c')
   * s.findLongestMatch(0, 2, 0, 1) // [0, 0, 0]
   */
    findLongestMatch (
        alo: number,
        ahi: number,
        blo: number,
        bhi: number,
    ) {
    // CAUTION: stripping common prefix or suffix would be incorrect.
    // E.g.,
    //    ab
    //    acab
    // Longest matching block is "ab", but if common prefix is
    // stripped, it's "a" (tied with "b").  UNIX(tm) diff does so
    // strip, so ends up claiming that ab is changed to acab by
    // inserting "ca" in the middle.  That's minimal but unintuitive:
    // "it's obvious" that someone inserted "ac" at the front.
    // Windiff ends up at the same place as diff, but by pairing up
    // the unique 'b's and then matching the first two 'a's.

        const [a, b, b2j, isbjunk] = [this.a, this.b, this.b2j, this.isbjunk];
        let [besti, bestj, bestsize] = [alo, blo, 0];

        // find longest junk-free match
        // during an iteration of the loop, j2len[j] = length of longest
        // junk-free match ending with a[i-1] and b[j]
        let j2len: Record<string, number> = {};
        for (let i = alo, end = ahi, asc = alo <= end; asc ? i < end : i > end; asc ? i++ : i--) {
            // look at all instances of a[i] in b; note that because
            // b2j has no junk keys, the loop is skipped if a[i] is junk
            const newj2len: Record<string, number> = {};
            const jarray = _has(b2j, a[i]) ? b2j[a[i]] : [];
            for (const j of jarray) {
                // a[i] matches b[j]
                if (j < blo) {
                    continue;
                }
                if (j >= bhi) {
                    break;
                }
                const k = newj2len[j] = (j2len[j - 1] || 0) + 1;
                if (k > bestsize) {
                    [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
                }
            }
            j2len = newj2len;
        }

        // Extend the best by non-junk elements on each end.  In particular,
        // "popular" non-junk elements aren't in b2j, which greatly speeds
        // the inner loop above, but also means "the best" match so far
        // doesn't contain any junk *or* popular non-junk elements.
        while (besti > alo && bestj > blo &&
            !isbjunk(b[bestj - 1]) &&
            a[besti - 1] === b[bestj - 1]) {
            [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
        }
        while (besti + bestsize < ahi && bestj + bestsize < bhi &&
            !isbjunk(b[bestj + bestsize]) &&
            a[besti + bestsize] === b[bestj + bestsize]) {
            bestsize++;
        }

        // Now that we have a wholly interesting match (albeit possibly
        // empty!), we may as well suck up the matching junk on each
        // side of it too.  Can't think of a good reason not to, and it
        // saves post-processing the (possibly considerable) expense of
        // figuring out what to do with it.  In the case of an empty
        // interesting match, this is clearly the right thing to do,
        // because no other kind of match is possible in the regions.
        while (besti > alo && bestj > blo &&
            isbjunk(b[bestj - 1]) &&
            a[besti - 1] === b[bestj - 1]) {
            [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
        }
        while (besti + bestsize < ahi && bestj + bestsize < bhi &&
            isbjunk(b[bestj + bestsize]) &&
            a[besti + bestsize] === b[bestj + bestsize]) {
            bestsize++;
        }

        return [besti, bestj, bestsize];
    }

    /**
   * Return list of triples describing matching subsequences.
   *
   * Each triple is of the form [i, j, n], and means that
   * a[i...i+n] == b[j...j+n].
   *
   * The triples are monotonically increasing in
   * i and in j.  it's also guaranteed that if
   * [i, j, n] and [i', j', n'] are adjacent triples in the list, and
   * the second is not the last triple in the list, then i+n != i' or
   * j+n != j'. IOW, adjacent triples never describe adjacent equal
   * blocks.
   *
   * The last triple is a dummy, [a.length, b.length, 0], and is the only
   * triple with n==0.
   *
   * @example
   * const s = new SequenceMatcher(null, 'abxcd', 'abcd')
   * s.getMatchingBlocks() // [[0, 0, 2], [3, 2, 2], [5, 4, 0]]
   */
    getMatchingBlocks () {
        let j1, k1;
        if (this.matchingBlocks) {
            return this.matchingBlocks;
        }
        const [la, lb] = [this.a.length, this.b.length];

        // This is most naturally expressed as a recursive algorithm, but
        // at least one user bumped into extreme use cases that exceeded
        // the recursion limit on their box.  So, now we maintain a list
        // ('queue`) of blocks we still need to look at, and append partial
        // results to `matching_blocks` in a loop; the matches are sorted
        // at the end.
        const queue = [[0, la, 0, lb]];
        const matchingBlocks: number[][] = [];
        while (queue.length) {
            const [alo, ahi, blo, bhi] = queue.pop()!;
            const x = this.findLongestMatch(alo, ahi, blo, bhi);
            const [i, j, k] = x;
            // a[alo...i] vs b[blo...j] unknown
            // a[i...i+k] same as b[j...j+k]
            // a[i+k...ahi] vs b[j+k...bhi] unknown
            if (k) {
                matchingBlocks.push(x);
                if (alo < i && blo < j) {
                    queue.push([alo, i, blo, j]);
                }
                if (i + k < ahi && j + k < bhi) {
                    queue.push([i + k, ahi, j + k, bhi]);
                }
            }
        }
        matchingBlocks.sort(_arrayCmp);

        // It's possible that we have adjacent equal blocks in the
        // matching_blocks list now.
        let i1 = j1 = k1 = 0;

        const nonAdjacent = new Array<[number, number, number]>();
        for (const [i2, j2, k2] of matchingBlocks) {
            // Is this block adjacent to i1, j1, k1?
            if (i1 + k1 === i2 && j1 + k1 === j2) {
                // Yes, so collapse them -- this just increases the length of
                // the first block by the length of the second, and the first
                // block so lengthened remains the block to compare against.
                k1 += k2;
            } else {
                // Not adjacent.  Remember the first block (k1==0 means it's
                // the dummy we started with), and make the second block the
                // new block to compare against.
                if (k1) {
                    nonAdjacent.push([i1, j1, k1]);
                }
                [i1, j1, k1] = [i2, j2, k2];
            }
        }
        if (k1) {
            nonAdjacent.push([i1, j1, k1]);
        }

        nonAdjacent.push([la, lb, 0]);
        return this.matchingBlocks = nonAdjacent;
    }

    /**
   * Return a measure of the sequences' similarity (float in [0,1]).
   * Where T is the total number of elements in both sequences, and
   * M is the number of matches, this is 2.0*M / T.
   *
   * Note that this is 1 if the sequences are identical, and 0 if
   * they have nothing in common.
   *
   * `.ratio()` is expensive to compute if you haven't already computed
   * `.getMatchingBlocks()` or `.getOpcodes()`, in which case you may
   * want to try `.quickRatio()` or `.realQuickRatio()` first to get an
   * upper bound.
   *
   * @example
   * const s = new SequenceMatcher(null, 'abcd', 'bcde')
   * s.ratio() // 0.75
   * s.quickRatio() // 0.75
   * s.realQuickRatio() // 1.0
   */
    ratio () {
        let matches = 0;
        for (const match of this.getMatchingBlocks()) {
            matches += match[2];
        }
        return _calculateRatio(matches, this.a.length + this.b.length);
    }

    /**
   * Return an upper bound on `ratio()` relatively quickly.
   * This isn't defined beyond that it is an upper bound on `.ratio()`, and
   * is faster to compute.
   */
    quickRatio () {
    // viewing a and b as multisets, set matches to the cardinality
    // of their intersection; this counts the number of matches
    // without regard to order, so is clearly an upper bound
        let elt, fullbcount: Record<string, number>;
        if (!this.fullbcount) {
            this.fullbcount = fullbcount = {};
            for (elt of this.b) {
                fullbcount[elt] = (fullbcount[elt] || 0) + 1;
            }
        }

        fullbcount = this.fullbcount;
        // avail[x] is the number of times x appears in 'b' less the
        // number of times we've seen it in 'a' so far ... kinda
        const avail: Record<string, number> = {};
        let matches = 0;
        for (elt of this.a) {
            let numb;
            if (_has(avail, elt)) {
                numb = avail[elt];
            } else {
                numb = fullbcount[elt] || 0;
            }
            avail[elt] = numb - 1;
            if (numb > 0) {
                matches++;
            }
        }
        return _calculateRatio(matches, this.a.length + this.b.length);
    }

    /**
   * Return an upper bound on `ratio()` very quickly.
   * This isn't defined beyond that it is an upper bound on `.ratio()`, and
   * is faster to compute than either `.ratio()` or `.quickRatio()`.
   */
    realQuickRatio () {
        const [la, lb] = [this.a.length, this.b.length];
        // can't have more matches than the number of elements in the
        // shorter sequence
        return _calculateRatio(Math.min(la, lb), la + lb);
    }
}
