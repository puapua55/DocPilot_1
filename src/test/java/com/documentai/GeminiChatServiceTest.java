package com.documentai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.jsonPath;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class GeminiChatServiceTest {
    @Test
    void missingApiKeyIsReportedBeforeCallingGemini() {
        var service = new GeminiChatService(RestClient.builder(), new ObjectMapper(), "", "test-model");
        var error = assertThrows(ResponseStatusException.class, () -> service.chat(request()));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatusCode());
        assertTrue(error.getReason().contains("GEMINI_API_KEY"));
    }

    @Test
    void generateContentRequestUsesGeminiHeadersAndPayloadShape() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        var service = new GeminiChatService(builder, new ObjectMapper(), "test-key", "test-model");

        server.expect(requestTo("https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"))
                .andExpect(method(org.springframework.http.HttpMethod.POST))
                .andExpect(header("x-goog-api-key", "test-key"))
                .andExpect(header("Content-Type", org.hamcrest.Matchers.containsString(MediaType.APPLICATION_JSON_VALUE)))
                .andExpect(jsonPath("$.systemInstruction.parts[0].text").value(org.hamcrest.Matchers.containsString("DocPilot")))
                .andExpect(jsonPath("$.contents[0].role").value("user"))
                .andExpect(jsonPath("$.contents[0].parts[0].text").value("테스트를 찾아줘"))
                .andExpect(jsonPath("$.generationConfig.responseMimeType").value("application/json"))
                .andRespond(withSuccess("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{\\\"answer\\\":\\\"검색 준비\\\",\\\"intent\\\":\\\"search\\\",\\\"action\\\":{\\\"type\\\":\\\"search\\\",\\\"keyword\\\":\\\"테스트\\\"}}\"}]}}]}", MediaType.APPLICATION_JSON));

        var result = service.chat(request());
        assertEquals("search", result.intent());
        assertEquals("테스트", result.action().keyword());
        server.verify();
    }

    @Test
    void quotaErrorIsReturnedAsActionableMessageWithoutRawProviderMessage() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        var service = new GeminiChatService(builder, new ObjectMapper(), "test-key", "test-model");
        server.expect(requestTo("https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"))
                .andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"error\":{\"code\":429,\"status\":\"RESOURCE_EXHAUSTED\",\"message\":\"private provider detail\"}}"));

        var error = assertThrows(ResponseStatusException.class, () -> service.chat(request()));
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, error.getStatusCode());
        assertTrue(error.getReason().contains("사용량/한도 오류"));
        assertFalse(error.getReason().contains("private provider detail"));
    }

    @Test
    void providerStatusCategoriesRemainDistinguishable() {
        assertEquals("API Key 오류", GeminiChatService.classifyGeminiError(401, new GeminiChatService.GeminiErrorDetails("", "", "")));
        assertEquals("권한/결제 오류", GeminiChatService.classifyGeminiError(403, new GeminiChatService.GeminiErrorDetails("", "", "")));
        assertEquals("모델명 오류", GeminiChatService.classifyGeminiError(404, new GeminiChatService.GeminiErrorDetails("NOT_FOUND", "", "")));
        assertEquals("요청 형식 오류", GeminiChatService.classifyGeminiError(400, new GeminiChatService.GeminiErrorDetails("INVALID_ARGUMENT", "", "")));
    }

    @Test
    void documentInstructionsLimitRequestsToThreeActions() {
        String instructions = GeminiChatService.documentAssistantInstructions();
        assertTrue(instructions.contains("정확한 문서 검색"));
        assertTrue(instructions.contains("위치 하이라이트"));
        assertTrue(instructions.contains("즉시 텍스트 교체"));
        assertTrue(instructions.contains("일반 대화"));
        assertTrue(instructions.contains("unsupported"));
    }

    @Test
    void parsesOnlySearchHighlightAndReplaceActions() {
        GeminiChatService service = service();
        var search = service.parseChatResult("{\"answer\":\"검색 준비\",\"intent\":\"search\",\"action\":{\"type\":\"search\",\"keyword\":\"테스트\"}}");
        assertEquals("search", search.intent());
        assertEquals("테스트", search.action().keyword());

        var highlight = service.parseChatResult("{\"answer\":\"강조 준비\",\"intent\":\"highlight\",\"action\":{\"type\":\"highlight\",\"keyword\":\"테스트\"}}");
        assertEquals("highlight", highlight.intent());

        var replace = service.parseChatResult("{\"answer\":\"치환 준비\",\"intent\":\"replace\",\"action\":{\"type\":\"replace\",\"originalText\":\"테스트\",\"newText\":\"시험\"}}");
        assertEquals("replace", replace.intent());
        assertEquals("시험", replace.action().newText());
    }

    @Test
    void generalChatAndInvalidResponsesAreRestricted() {
        var summary = service().parseChatResult("{\"answer\":\"요약\",\"intent\":\"summarize\",\"action\":null}");
        assertEquals("unsupported", summary.intent());
        assertEquals(GeminiChatService.RESTRICTED_CHAT_MESSAGE, summary.answer());
        assertNull(summary.action());

        var invalid = service().parseChatResult("JSON이 아닌 기존 답변");
        assertEquals("unsupported", invalid.intent());
        assertEquals(GeminiChatService.RESTRICTED_CHAT_MESSAGE, invalid.answer());
    }

    @Test
    void longDocumentKeepsHeadAndTailAndMarksTruncation() {
        String source = "A".repeat(10_001) + "MIDDLE".repeat(2_000) + "Z".repeat(10_001);
        var result = GeminiChatService.limitDocumentText(source);
        assertTrue(result.truncated());
        assertTrue(result.text().startsWith("A".repeat(100)));
        assertTrue(result.text().contains("문서 중간 내용 생략"));
        assertTrue(result.text().endsWith("Z".repeat(100)));
    }

    private GeminiChatService service() {
        return new GeminiChatService(RestClient.builder(), new ObjectMapper(), "test-key", "test-model");
    }

    private ChatController.ChatRequest request() {
        return new ChatController.ChatRequest("테스트를 찾아줘", "sample.pdf", "pdf", "문서 본문", List.of());
    }
}
