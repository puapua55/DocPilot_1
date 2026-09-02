package com.documentai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.springframework.http.HttpStatus.BAD_GATEWAY;
import static org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE;

@Service
public class OpenAiChatService {
    static final int MAX_HISTORY = 10;
    static final int MAX_DOCUMENT_TEXT = 20_000;
    static final int DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;
    private static final Set<String> INTENTS = Set.of("summarize", "question_answer", "search", "highlight", "replace", "unsupported");

    private static final String DOCUMENT_ASSISTANT_INSTRUCTIONS = """
            너는 DocPilot의 문서 작업 보조 AI다. 사용자가 문서를 선택한 경우 제공된 문서 텍스트를 최우선 근거로 답변한다.
            제공된 문서 내용에 없는 정보는 추측하지 말고 '제공된 문서에서는 확인되지 않습니다'라고 답한다.
            사용자 요청을 summarize, question_answer, search, highlight, replace, unsupported 중 정확히 하나로 분류한다.
            요약은 summarize, 문서 내용 질문은 question_answer다. 검색 요청은 search이며 keyword를 추출한다.
            하이라이트/표시 요청은 highlight이며 keyword를 추출한다. 텍스트 치환 요청은 replace이며 originalText와 newText를 추출한다.
            search/highlight/replace 작업을 직접 실행했다고 절대 말하지 않는다. 실행 가능한 작업을 준비했다고 설명하고 반드시 사용자 승인 버튼을 눌러야 실행된다고 안내한다.
            페이지 번호가 문서 텍스트에 있으면 가능한 경우 답변에 언급하고, 없으면 페이지를 추측하지 않는다.
            지원하지 않는 문서 자동 편집 요청은 unsupported로 분류한다.
            응답은 JSON 객체만 출력한다. 형식은 {\"answer\":\"...\",\"intent\":\"...\",\"action\":null}이다.
            search action은 {\"type\":\"search\",\"keyword\":\"...\"}, highlight action은 {\"type\":\"highlight\",\"keyword\":\"...\"},
            replace action은 {\"type\":\"replace\",\"originalText\":\"...\",\"newText\":\"...\"} 형식으로 작성한다.
            summarize/question_answer/unsupported의 action은 null이다. JSON 외 설명이나 Markdown 코드 블록을 출력하지 않는다.
            문서 텍스트가 제공되지 않은 경우 일반 질문과 DocPilot 사용 질문에는 답할 수 있지만 문서 작업을 실행했다고 말하지 않는다.
            """;

    private final RestClient restClient;
    private final ObjectMapper objectMapper;
    private final String apiKey;
    private final String model;

    public OpenAiChatService(RestClient.Builder restClientBuilder, ObjectMapper objectMapper,
                             @Value("${openai.api-key:}") String apiKey,
                             @Value("${openai.model:gpt-5.6-luna}") String model) {
        this.restClient = restClientBuilder.baseUrl("https://api.openai.com/v1").build();
        this.objectMapper = objectMapper;
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.model = model;
    }

    public ChatResult chat(ChatController.ChatRequest request) {
        if (apiKey.isBlank()) {
            throw new ResponseStatusException(SERVICE_UNAVAILABLE, "OPENAI_API_KEY가 설정되지 않았습니다. 백엔드 환경변수에 API Key를 설정해주세요.");
        }
        String rawDocumentText = request.documentText() == null ? "" : request.documentText();
        System.out.println("[Chat] documentName=" + safeLogValue(request.documentName()));
        System.out.println("[Chat] documentType=" + safeLogValue(request.documentType()));
        System.out.println("[Chat] documentTextLength=" + rawDocumentText.length());

        LimitedDocumentText limitedDocument = limitDocumentText(rawDocumentText);
        List<Map<String, Object>> input = new ArrayList<>();
        input.add(message("developer", DOCUMENT_ASSISTANT_INSTRUCTIONS));
        String documentContext = buildDocumentContext(request, limitedDocument);
        if (!documentContext.isBlank()) input.add(message("developer", documentContext));

        List<ChatController.ChatMessage> history = request.history() == null ? List.of() : request.history();
        int fromIndex = Math.max(0, history.size() - MAX_HISTORY);
        for (ChatController.ChatMessage item : history.subList(fromIndex, history.size())) {
            if (item == null || item.content() == null || item.content().isBlank()) continue;
            input.add(message("assistant".equals(item.role()) ? "assistant" : "user", item.content().trim()));
        }
        if (input.stream().noneMatch(item -> "user".equals(item.get("role")))) input.add(message("user", request.message().trim()));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("store", false);
        body.put("input", input);

        try {
            JsonNode response = restClient.post().uri("/responses").contentType(MediaType.APPLICATION_JSON)
                    .header("Authorization", "Bearer " + apiKey).body(body).retrieve().body(JsonNode.class);
            String rawAnswer = extractOutputText(response);
            if (rawAnswer.isBlank()) throw new ResponseStatusException(BAD_GATEWAY, "OpenAI 응답에서 텍스트를 찾지 못했습니다.");
            return parseChatResult(rawAnswer);
        } catch (ResponseStatusException error) {
            throw error;
        } catch (Exception error) {
            throw new ResponseStatusException(BAD_GATEWAY, "OpenAI API 호출에 실패했습니다.", error);
        }
    }

    ChatResult parseChatResult(String rawAiText) {
        String raw = rawAiText == null ? "" : rawAiText.trim();
        try {
            JsonNode root = objectMapper.readTree(stripJsonFence(raw));
            String answer = root.path("answer").asText("").trim();
            String intent = root.path("intent").asText("question_answer").trim();
            if (!INTENTS.contains(intent)) intent = "unsupported";
            ChatController.ChatAction action = parseAction(root.path("action"), intent);
            return new ChatResult(answer.isBlank() ? raw : answer, intent, action);
        } catch (Exception ignored) {
            return new ChatResult(raw, "question_answer", null);
        }
    }

    private ChatController.ChatAction parseAction(JsonNode node, String intent) {
        if (node == null || node.isNull() || !node.isObject()) return null;
        if (!Set.of("search", "highlight", "replace").contains(intent)) return null;
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
        if (limitedDocument.text().isBlank()) {
            context.append("문서 내용: 현재 선택된 문서 내용은 전달되지 않았습니다.");
            return context.toString();
        }
        context.append("문서 내용:\n").append(limitedDocument.text());
        context.append(limitedDocument.truncated()
                ? "\n\n[알림: 문서가 길어 앞부분과 뒷부분만 제공되었습니다. 전체 문서를 본 것처럼 단정하지 말고 제공된 일부 내용 기준으로만 답변하세요.]"
                : "\n\n[알림: 답변은 위에 제공된 문서 내용만 근거로 작성하세요.]");
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
    private Map<String, Object> message(String role, String content) { return Map.of("role", role, "content", content); }

    private String extractOutputText(JsonNode response) {
        if (response == null || !response.path("output").isArray()) return "";
        StringBuilder text = new StringBuilder();
        for (JsonNode item : response.path("output")) {
            if (!item.path("content").isArray()) continue;
            for (JsonNode part : item.path("content")) {
                if ("output_text".equals(part.path("type").asText())) {
                    String value = part.path("text").asText("");
                    if (!value.isBlank()) { if (!text.isEmpty()) text.append('\n'); text.append(value); }
                }
            }
        }
        return text.toString().trim();
    }

    record LimitedDocumentText(String text, boolean truncated) {}
    record ChatResult(String answer, String intent, ChatController.ChatAction action) {}
}
