export enum UserFlag {
    HackedAndRecovered = "recovered",
    Scammed = "scammed",
    Locked = "locked",
    FutureNSFW = "futurensfw",
}

export interface ModmailMessage {
    conversationId: string;
    createdAt: Date;
    subject: string;
    participant?: string;
    messageAuthor: string;
    messageAuthorIsMod: boolean;
    bodyMarkdown: string;
    firstMessageBodyMarkdown?: string;
    isFirstMessage: boolean;
    isInternal: boolean;
    isHighlighted?: boolean;
}

export enum ConfigWikiPage {
    AutoAppealHandling = "autoAppealHandling",
    ControlSubSettings = "controlSubSettings",
}

export enum FormName {
    ClientSubReportUser = "clientSubReportUser",
    ClientSubQueryUser = "clientSubQueryUser",
    ControlSubForm = "controlSubForm",
    ControlSubQuerySubmissionForm = "controlSubQuerySubmissionForm",
    ShowCurrentEvaluationForm = "showCurrentEvaluationForm",
}

export enum ControlSubAction {
    RegenerateSummary = "generateSummary",
    QuerySubmission = "querySubmission",
    RemoveRecordForUser = "removeRecordForUser",
    CheckCurrentEvaluation = "checkCurrentEvaluation",
}
