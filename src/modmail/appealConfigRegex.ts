export interface AppealRegexConfig {
    "name": string;
    "usernameRegex"?: string[];
    "~usernameRegex"?: string[];
    "messageBodyRegex"?: string[];
    "~messageBodyRegex"?: string[];
    "evaluatorNameRegex"?: string[];
    "~evaluatorNameRegex"?: string[];
    "evaluatorHitReasonRegex"?: string[];
    "~evaluatorHitReasonRegex"?: string[];
    "currentEvaluatorNameRegex"?: string[];
    "~currentEvaluatorNameRegex"?: string[];
    "currentEvaluatorHitReasonRegex"?: string[];
    "~currentEvaluatorHitReasonRegex"?: string[];
    "bioRegex"?: string[];
    "~bioRegex"?: string[];
    "originalBioRegex"?: string[];
    "~originalBioRegex"?: string[];
    "socialLinkRegex"?: string[];
    "~socialLinkRegex"?: string[];
    "originalSocialLinkRegex"?: string[];
    "~originalSocialLinkRegex"?: string[];
    "modNoteTextRegex"?: string[];
    "~modNoteTextRegex"?: string[];
}

export type AppealRegexProperty = `${string}Regex`;

const appealRegexFlags: Partial<Record<AppealRegexProperty, string>> = {
    "bioRegex": "iu",
    "~bioRegex": "iu",
    "originalBioRegex": "iu",
    "~originalBioRegex": "iu",
    "modNoteTextRegex": "u",
    "~modNoteTextRegex": "u",
};

export type CompiledAppealRegexes = Partial<Record<AppealRegexProperty, RegExp[]>>;

export type AppealConfigWithCompiledRegexes<T extends AppealRegexConfig> = T & {
    compiledRegexes: CompiledAppealRegexes;
};

function isAppealRegexProperty (property: string): property is AppealRegexProperty {
    return property.endsWith("Regex");
}

function isStringArray (value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

function getAppealRegexValues (value: unknown): string[] | undefined {
    if (typeof value === "string") {
        return [value];
    }

    return isStringArray(value) ? value : undefined;
}

function getAppealRegexEntries (config: AppealRegexConfig): [AppealRegexProperty, string[]][] {
    const entries: [AppealRegexProperty, string[]][] = [];

    for (const [property, value] of Object.entries(config)) {
        if (!isAppealRegexProperty(property)) {
            continue;
        }

        const values = getAppealRegexValues(value);
        if (values) {
            entries.push([property, values]);
        }
    }

    return entries;
}

function getAppealRegexFlags (property: AppealRegexProperty): string {
    return appealRegexFlags[property] ?? "i";
}

export function compileAppealConfigRegexes<T extends AppealRegexConfig> (config: T): AppealConfigWithCompiledRegexes<T> {
    const compiledRegexes: CompiledAppealRegexes = {};

    for (const [property, values] of getAppealRegexEntries(config)) {
        compiledRegexes[property] = values.map(value => new RegExp(value, getAppealRegexFlags(property)));
    }

    return {
        ...config,
        compiledRegexes,
    };
}

export function compileAppealConfigs<T extends AppealRegexConfig> (configs: T[]): AppealConfigWithCompiledRegexes<T>[] {
    return configs.map(config => compileAppealConfigRegexes(config));
}

export function getAppealConfigRegexIssues (configs: AppealRegexConfig[]): string[] {
    const issues: string[] = [];

    for (const config of configs) {
        for (const [property, values] of getAppealRegexEntries(config)) {
            values.forEach((value, index) => {
                try {
                    new RegExp(value, getAppealRegexFlags(property));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    issues.push(`Invalid regex in ${property}[${index}] for config ${config.name}: ${message}`);
                }
            });
        }
    }

    return issues;
}
