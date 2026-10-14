import { SettingsValidationRequest, SettingsValidationResponse } from "@devvit/web/shared";
import type { Context } from "hono";

export const handleSelectFieldHasOptionChosen = async (c: Context): Promise<Response> => {
    const validationRequest = await c.req.json<SettingsValidationRequest<string[]>>();

    if (validationRequest.value?.length !== 1) {
        return c.json<SettingsValidationResponse>({
            success: false,
            error: "You must select an option.",
        });
    }

    return c.json<SettingsValidationResponse>({ success: true }, 200);
};
