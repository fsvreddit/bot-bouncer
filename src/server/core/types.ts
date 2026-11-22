export interface ModmailMessage {
    conversationId: string;
    createdAt: Date;
    subject: string;
    participant?: string;
    messageAuthor: string;
    messageAuthorIsMod: boolean;
    bodyMarkdown: string;
    firstMessageAuthor?: string;
    firstMessageBodyMarkdown?: string;
    isFirstMessage: boolean;
    isFirstParticipantReply: boolean;
    isInternal: boolean;
    isHighlighted?: boolean;
}

export enum ConfigWikiPage {
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
