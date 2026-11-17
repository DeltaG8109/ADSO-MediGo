const { createMetaWhatsAppCloudApi } = require("../src/modules/whatsapp/meta-cloud-api");

describe("Meta WhatsApp Cloud API", () => {
  test("envía el código con una plantilla configurada", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.test" }] })
    });
    const api = createMetaWhatsAppCloudApi({
      environment: {
        WHATSAPP_ACCESS_TOKEN: "token-test",
        WHATSAPP_PHONE_NUMBER_ID: "123456",
        WHATSAPP_VERIFICATION_TEMPLATE: "medigo_code",
        WHATSAPP_VERIFICATION_TEMPLATE_LANGUAGE: "es",
        WHATSAPP_GRAPH_API_VERSION: "v27.0"
      },
      fetchImpl
    });
    const result = await api.sendVerificationCode({ to: "+573001234567", code: "123456" });
    expect(result.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://graph.facebook.com/v27.0/123456/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-test" }),
        body: expect.stringContaining('"text":"123456"')
      })
    );
  });

  test("no simula el envío si faltan credenciales", async () => {
    const fetchImpl = jest.fn();
    const api = createMetaWhatsAppCloudApi({ environment: {}, fetchImpl });
    const result = await api.sendVerificationCode({ to: "+573001234567", code: "123456" });
    expect(result.status).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
