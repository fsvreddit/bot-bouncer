const SUBSTITUTIONS = {
    "{{STATE}}": [
        "Alabama",
        "Alaska",
        "Arizona",
        "Arkansas",
        "California",
        "Colorado",
        "Connecticut",
        "Delaware",
        "Florida",
        "Georgia",
        "Hawaii",
        "Idaho",
        "Illinois",
        "Indiana",
        "Iowa",
        "Kansas",
        "Kentucky",
        "Louisiana",
        "Maine",
        "Maryland",
        "Massachusetts",
        "Michigan",
        "Minnesota",
        "Mississippi",
        "Missouri",
        "Montana",
        "Nebraska",
        "Nevada",
        "New Hampshire",
        "New Jersey",
        "New Mexico",
        "New York",
        "North Carolina",
        "North Dakota",
        "Ohio",
        "Oklahoma",
        "Oregon",
        "Pennsylvania",
        "Rhode Island",
        "South Carolina",
        "South Dakota",
        "Tennessee",
        "Texas",
        "Utah",
        "Vermont",
        "Virginia",
        "Washington",
        "West Virginia",
        "Wisconsin",
        "Wyoming",
        "Jersey",
    ],
    "{{AGE}}": Array.from({ length: 23 }, (_, i) => (18 + i).toString())
        .flatMap(age => [age, `${age}yo`]),
    "{{GREETING}}": [
        "hello",
        "hi",
        "hey",
        "hiya",
        "howdy",
    ],
};

export function getSubstitutedText (input: string): string {
    let substitutedText = input;
    for (const [replacement, values] of Object.entries(SUBSTITUTIONS)) {
        // Order values by length descending
        const sortedValues = values.sort((a, b) => b.length - a.length);
        for (const value of sortedValues) {
            substitutedText = substitutedText.replace(new RegExp(`\\b${value}\\b`, "g"), replacement);
        }
    }
    return substitutedText;
}
