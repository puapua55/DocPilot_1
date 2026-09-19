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

class OpenAiChatServiceTest {
    @Test
    void missingApiKeyIsReportedBeforeCallingOpenAi() {
        var service = new OpenAiChatService(RestClient.builder(), new ObjectMapper(), "", "test-model");
        var error = assertThrows(ResponseStatusException.class, () -> service.chat(request()));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatusCode());
        assertTrue(error.getReason().contains("OPENAI_API_KEY"));
    }

    @Test
    void responsesRequestUsesModelHeadersAndInputShape() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        var service = new OpenAiChatService(builder, new ObjectMapper(), "test-key", "test-model");

        server.expect(requestTo("https://api.openai.com/v1/responses"))
                .andExpect(method(org.springframework.http.HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer test-key"))
                .andExpect(header("Content-Type", org.hamcrest.Matchers.containsString(MediaType.APPLICATION_JSON_VALUE)))
                .andExpect(jsonPath("$.model").value("test-model"))
                .andExpect(jsonPath("$.input[0].role").value("developer"))
                .andExpect(jsonPath("$.input[2].role").value("user"))
                .andExpect(jsonPath("$.input[2].content").value("질문"))
                .andRespond(withSuccess("{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"응답\"}]}]}", MediaType.APPLICATION_JSON));

        assertEquals("응답", service.chat(request()).answer());
        server.verify();
    }

    @Test
    void quotaErrorIsReturnedAsActionableMessageWithoutRawProviderMessage() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        var service = new OpenAiChatService(builder, new ObjectMapper(), "test-key", "test-model");
        server.expect(requestTo("https://api.openai.com/v1/responses"))
                .andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"error\":{\"type\":\"insufficient_quota\",\"code\":\"credit_balance_exhausted\",\"message\":\"private provider detail\"}}"));

        var error = assertThrows(ResponseStatusException.class, () -> service.chat(request()));
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, error.getStatusCode());
        assertTrue(error.getReason().contains("사용량/한도 오류"));
        assertTrue(error.getReason().contains("credit_balance_exhausted"));
        assertFalse(error.getReason().contains("private provider detail"));
    }

    @Test
    void providerStatusCategoriesRemainDistinguishable() {
        assertEquals("API Key 오류", OpenAiChatService.classifyOpenAiError(401, new OpenAiChatService.OpenAiErrorDetails("", "", "")));
        assertEquals("권한/결제 오류", OpenAiChatService.classifyOpenAiError(403, new OpenAiChatService.OpenAiErrorDetails("", "", "")));
        assertEquals("모델명 오류", OpenAiChatService.classifyOpenAiError(400, new OpenAiChatService.OpenAiErrorDetails("invalid_request_error", "model_not_found", "")));
        assertEquals("요청 형식 오류", OpenAiChatService.classifyOpenAiError(400, new OpenAiChatService.OpenAiErrorDetails("invalid_request_error", "", "invalid input")));
    }

    @Test
    void documentInstructionsRequireGroundedAnswersAndApproval() {
        String instructions = OpenAiChatService.documentAssistantInstructions();
        assertTrue(instructions.contains("최우선 근거"));
        assertTrue(instructions.contains("제공된 문서에서는 확인되지 않습니다"));
        assertTrue(instructions.contains("페이지 번호"));
        assertTrue(instructions.contains("사용자 승인"));
        assertTrue(instructions.contains("search"));
        assertTrue(instructions.contains("highlight"));
        assertTrue(instructions.contains("replace"));
    }

    @Test
    void parsesSearchHighlightAndReplaceActions() {
        OpenAiChatService service = service();
        var search = service.parseChatResult("{\"answer\":\"검색 준비\",\"intent\":\"search\",\"action\":{\"type\":\"search\",\"keyword\":\"테스트\"}}");
        assertEquals("search", search.intent());
        assertEquals("테스트", search.action().keyword());

        var highlight = service.parseChatResult("{\"answer\":\"강조 준비\",\"intent\":\"highlight\",\"action\":{\"type\":\"highlight\",\"keyword\":\"테스트\"}}");
        assertEquals("highlight", highlight.intent());
        assertEquals("테스트", highlight.action().keyword());

        var replace = service.parseChatResult("{\"answer\":\"치환 준비\",\"intent\":\"replace\",\"action\":{\"type\":\"replace\",\"originalText\":\"테스트\",\"newText\":\"시험\"}}");
        assertEquals("replace", replace.intent());
        assertEquals("테스트", replace.action().originalText());
        assertEquals("시험", replace.action().newText());
    }

    @Test
    void parsingFailureFallsBackWithoutThrowing() {
        var result = service().parseChatResult("JSON이 아닌 기존 답변");
        assertEquals("JSON이 아닌 기존 답변", result.answer());
        assertEquals("question_answer", result.intent());
        assertNull(result.action());
    }

    @Test
    void unsupportedAndAnswerIntentsDoNotExposeActions() {
        var unsupported = service().parseChatResult("{\"answer\":\"지원하지 않음\",\"intent\":\"unsupported\",\"action\":{\"type\":\"search\",\"keyword\":\"x\"}}");
        assertEquals("unsupported", unsupported.intent());
        assertNull(unsupported.action());
        var summary = service().parseChatResult("{\"answer\":\"요약\",\"intent\":\"summarize\",\"action\":null}");
        assertNull(summary.action());
    }

    @Test
    void shortDocumentIsNotTruncated() {
        var result = OpenAiChatService.limitDocumentText("[1페이지]\n테스트 문서");
        assertFalse(result.truncated());
        assertEquals("[1페이지]\n테스트 문서", result.text());
    }

    @Test
    void longDocumentKeepsHeadAndTailAndMarksTruncation() {
        String source = "A".repeat(10_001) + "MIDDLE".repeat(2_000) + "Z".repeat(10_001);
        var result = OpenAiChatService.limitDocumentText(source);
        assertTrue(result.truncated());
        assertTrue(result.text().startsWith("A".repeat(100)));
        assertTrue(result.text().contains("문서 중간 내용 생략"));
        assertTrue(result.text().endsWith("Z".repeat(100)));
        assertTrue(OpenAiChatService.isDocumentTextTruncated(source));
    }

    @Test
    void truncatedDocumentContextWarnsThatOnlyPartialContentWasProvided() {
        String source = "앞".repeat(11_000) + "뒤".repeat(11_000);
        var limited = OpenAiChatService.limitDocumentText(source);
        var request = new ChatController.ChatRequest("요약해줘", "sample.pdf", "pdf", source, List.of());
        String context = OpenAiChatService.buildDocumentContext(request, limited);
        assertTrue(context.contains("sample.pdf"));
        assertTrue(context.contains("제공된 일부 내용 기준"));
        assertTrue(context.contains("전체 문서를 본 것처럼 단정하지 말고"));
    }

    private OpenAiChatService service() {
        return new OpenAiChatService(RestClient.builder(), new ObjectMapper(), "test-key", "test-model");
    }

    private ChatController.ChatRequest request() {
        return new ChatController.ChatRequest("질문", "", "", "", List.of());
    }
}
