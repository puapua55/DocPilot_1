package com.documentai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.springframework.http.HttpStatus.BAD_GATEWAY;
import static org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE;

@Service
public class GeminiChatService {
    private static final Logger log = LoggerFactory.getLogger(GeminiChatService.class);
    static final int MAX_HISTORY = 10;
    static final int MAX_DOCUMENT_TEXT = 20_000;
    static final int DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;
    private static final Set<String> ALLOWED_INTENTS = Set.of("search", "highlight", "replace");
    static final String RESTRICTED_CHAT_MESSAGE = "채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.";

    private static final String DOCUMENT_ASSISTANT_INSTRUCTIONS = """
            너는 DocPilot의 문서 작업 보조 AI다. 지원하는 요청은 정확한 문서 검색(search), 위치 하이라이트(highlight), 즉시 텍스트 교체(replace)뿐이다.
            요약, 문서 질의응답, 일반 대화, 사용법 안내, 그 밖의 모든 요청은 지원하지 않는다.
            지원하지 않는 요청에는 intent를 unsupported로, answer를 '채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.'로, action을 null로 설정한다.
            검색 요청은 search이며 keyword를 추출한다. 하이라이트/표시 요청은 highlight이며 keyword를 추출한다. 텍스트 치환 요청은 replace이며 originalText와 newText를 추출한다.
            search/highlight/replace 작업을 직접 실행했다고 절대 말하지 않는다. 실행 가능한 작업을 준비했다고 설명하고 반드시 사용자 승인 버튼을 눌러야 실행된다고 안내한다.
            응답은 JSON 객체만 출력한다. 형식은 {\"answer\":\"...\",\"intent\":\"search|highlight|replace|unsupported\",\"action\":null}이다.
            search action은 {\"type\":\"search\",\"keyword\":\"...\"}, highlight action은 {\"type\":\"highlight\",\"keyword\":\"...\"}, replace action은 {\"type\":\"replace\",\"originalText\":\"...\",\"newText\":\"...\"} 형식이다.
            unsupported의 action은 null이다. JSON 외 설명이나 Markdown 코드 블록을 출력하지 않는다.
            """;

    private final RestClient restClient;
    private final ObjectMapper objectMapper;
    private final String apiKey;
    private final String model;

    public GeminiChatService(RestClient.Builder restClientBuilder, ObjectMapper objectMapper,
                             @Value("${gemini.api-key:}") String apiKey,
                             @Value("${gemini.model:gemini-3.1-flash-lite}") String model) {
        this.restClient = restClientBuilder.baseUrl("https://generativelanguage.googleapis.com/v1beta").build();
        this.objectMapper = objectMapper;
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.model = model == null || model.isBlank() ? "gemini-3.1-flash-lite" : model.trim();
        log.info("[Gemini] configuration: apiKeyPresent={}, model={}", !this.apiKey.isBlank(), this.model);
    }

    public ChatResult chat(ChatController.ChatRequest request) {
        if (apiKey.isBlank()) {
            throw new ResponseStatusException(SERVICE_UNAVAILABLE, "GEMINI_API_KEY가 설정되지 않았습니다. 백엔드 환경변수에 API Key를 설정해주세요.");
        }
        String rawDocumentText = request.documentText() == null ? "" : request.documentText();
        log.info("[Chat] request: documentName={}, documentType={}, documentTextPresent={}, documentTextLength={}, historySize={}",
                safeLogValue(request.documentName()), safeLogValue(request.documentType()), !rawDocumentText.isBlank(),
                rawDocumentText.length(), request.history() == null ? 0 : request.history().size());

        LimitedDocumentText limitedDocument = limitDocumentText(rawDocumentText);
        String documentContext = buildDocumentContext(request, limitedDocument);
        List<Map<String, Object>> contents = new ArrayList<>();
        List<ChatController.ChatMessage> history = request.history() == null ? List.of() : request.history();
        int fromIndex = Math.max(0, history.size() - MAX_HISTORY);
        for (ChatController.ChatMessage item : history.subList(fromIndex, history.size())) {
            if (item == null || item.content() == null || item.content().isBlank()) continue;
            contents.add(message("assistant".equals(item.role()) ? "model" : "user", item.content().trim()));
        }
        if (contents.stream().noneMatch(item -> "user".equals(item.get("role")))) {
            contents.add(message("user", request.message().trim()));
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("systemInstruction", Map.of("parts", List.of(Map.of("text", DOCUMENT_ASSISTANT_INSTRUCTIONS + "\n\n" + documentContext))));
        body.put("contents", contents);
        body.put("generationConfig", Map.of("responseMimeType", "application/json", "temperature", 0, "maxOutputTokens", 400));

        try {
            String responseBody = restClient.post().uri("/models/{model}:generateContent", model).contentType(MediaType.APPLICATION_JSON)
                    .header("x-goog-api-key", apiKey).body(body).retrieve().body(String.class);
            String rawAnswer = extractOutputText(objectMapper.readTree(responseBody));
            if (rawAnswer.isBlank()) throw new ResponseStatusException(BAD_GATEWAY, "Gemini 응답에서 텍스트를 찾지 못했습니다.");
            return parseChatResult(rawAnswer);
        } catch (ResponseStatusException error) {
            throw error;
        } catch (RestClientResponseException error) {
            GeminiErrorDetails details = parseGeminiError(error);
            String category = classifyGeminiError(error.getStatusCode().value(), details);
            log.warn("[Gemini] request failed: status={}, category={}, statusName={}, code={}",
                    error.getStatusCode().value(), category, details.status(), details.code());
            throw new ResponseStatusException(error.getStatusCode().is4xxClientError() ? error.getStatusCode() : BAD_GATEWAY,
                    userMessage(category, details), error);
        } catch (JsonProcessingException error) {
            log.warn("[Gemini] response parsing failed: response format error");
            throw new ResponseStatusException(BAD_GATEWAY, "Gemini 응답 형식 오류입니다. Gemini API 응답을 확인해주세요.", error);
        } catch (RestClientException error) {
            log.warn("[Gemini] request failed: communication error={}", error.getClass().getSimpleName());
            throw new ResponseStatusException(BAD_GATEWAY, "Gemini 서버와 통신하지 못했습니다. 네트워크 또는 Gemini 서버 상태를 확인해주세요.", error);
        }
    }

    static String classifyGeminiError(int status, GeminiErrorDetails details) {
        String statusName = details.status().toLowerCase();
        String message = details.message().toLowerCase();
        if (status == 401) return "API Key 오류";
        if (status == 403) return "권한/결제 오류";
        if (status == 404 || statusName.contains("not_found") || message.contains("model") && message.contains("not found")) return "모델명 오류";
        if (status == 429) return "사용량/한도 오류";
        if (status >= 400 && status < 500) return "요청 형식 오류";
        return "Gemini 서버/API 통신 오류";
    }

    private String userMessage(String category, GeminiErrorDetails details) {
        String suffix = details.code().isBlank() ? "" : " (" + details.code() + ")";
        return "Gemini " + category + "입니다." + suffix + " Gemini 설정과 무료 등급 사용량을 확인해주세요.";
    }

    private GeminiErrorDetails parseGeminiError(RestClientResponseException error) {
        try {
            JsonNode details = objectMapper.readTree(error.getResponseBodyAsString()).path("error");
            return new GeminiErrorDetails(details.path("status").asText(""), details.path("code").asText(""), details.path("message").asText(""));
        } catch (Exception ignored) {
            return new GeminiErrorDetails("", "", "");
        }
    }

    ChatResult parseChatResult(String rawAiText) {
        try {
            JsonNode root = objectMapper.readTree(stripJsonFence(rawAiText == null ? "" : rawAiText.trim()));
            String intent = root.path("intent").asText("unsupported").trim();
            if (!ALLOWED_INTENTS.contains(intent)) return restrictedChatResult();
            ChatController.ChatAction action = parseAction(root.path("action"), intent);
            if (action == null) return restrictedChatResult();
            String answer = root.path("answer").asText("").trim();
            return new ChatResult(answer.isBlank() ? "문서 작업을 준비했습니다. 아래 버튼으로 실행해주세요." : answer, intent, action);
        } catch (Exception ignored) {
            return restrictedChatResult();
        }
    }

    private ChatResult restrictedChatResult() {
        return new ChatResult(RESTRICTED_CHAT_MESSAGE, "unsupported", null);
    }

    private ChatController.ChatAction parseAction(JsonNode node, String intent) {
        if (node == null || node.isNull() || !node.isObject()) return null;
        String type = node.path("type").asText("").trim();
        if (!intent.equals(type)) return null;
        if ("search".equals(type) || "highlight".equals(type)) {
            String keyword = node.path("keyword").asText("").trim();
            return keyword.isBlank() ? null : new ChatController.ChatAction(type, keyword, null, null);
        }
        String originalText = node.path("originalText").asText("").trim();
        String newText = node.path("newText").asText("");
        return originalText.isBlank() || newText.isEmpty() ? null : new ChatController.ChatAction(type, null, originalText, newText);
    }

    private static String stripJsonFence(String value) {
        if (value.startsWith("```json")) value = value.substring(7);
        else if (value.startsWith("```")) value = value.substring(3);
        if (value.endsWith("```")) value = value.substring(0, value.length() - 3);
        return value.trim();
    }

    static String documentAssistantInstructions() { return DOCUMENT_ASSISTANT_INSTRUCTIONS; }

    static String buildDocumentContext(ChatController.ChatRequest request, LimitedDocumentText limitedDocument) {
        StringBuilder context = new StringBuilder();
        context.append("아래는 현재 DocPilot에서 열린 문서의 컨텍스트다.\n");
        context.append("문서명: ").append(safePromptValue(request.documentName())).append('\n');
        context.append("문서 유형: ").append(safePromptValue(request.documentType())).append('\n');
        if (limitedDocument.text().isBlank()) return context.append("문서 내용: 현재 선택된 문서 내용은 전달되지 않았습니다.").toString();
        context.append("문서 내용:\n").append(limitedDocument.text());
        if (limitedDocument.truncated()) context.append("\n\n[알림: 문서가 길어 앞부분과 뒷부분만 제공되었습니다.]");
        return context.toString().trim();
    }

    static LimitedDocumentText limitDocumentText(String text) {
        if (text == null || text.isBlank()) return new LimitedDocumentText("", false);
        if (text.length() <= MAX_DOCUMENT_TEXT) return new LimitedDocumentText(text, false);
        return new LimitedDocumentText(text.substring(0, DOCUMENT_EDGE_LENGTH) + "\n\n[... 문서 중간 내용 생략 ...]\n\n" + text.substring(text.length() - DOCUMENT_EDGE_LENGTH), true);
    }

    static boolean isDocumentTextTruncated(String text) { return text != null && text.length() > MAX_DOCUMENT_TEXT; }
    private static String safeLogValue(String value) { return value == null ? "" : value.replaceAll("[\\r\\n]", " ").trim(); }
    private static String safePromptValue(String value) { return value == null || value.isBlank() ? "없음" : value.trim(); }
    private Map<String, Object> message(String role, String content) { return Map.of("role", role, "parts", List.of(Map.of("text", content))); }

    private String extractOutputText(JsonNode response) {
        StringBuilder text = new StringBuilder();
        for (JsonNode candidate : response.path("candidates")) {
            for (JsonNode part : candidate.path("content").path("parts")) {
                String value = part.path("text").asText("").trim();
                if (!value.isBlank()) { if (!text.isEmpty()) text.append('\n'); text.append(value); }
            }
        }
        return text.toString().trim();
    }

    record LimitedDocumentText(String text, boolean truncated) {}
    record ChatResult(String answer, String intent, ChatController.ChatAction action) {}
    record GeminiErrorDetails(String status, String code, String message) {}
}
