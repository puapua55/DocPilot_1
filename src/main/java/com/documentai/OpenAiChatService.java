package com.documentai;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.springframework.http.HttpStatus.BAD_GATEWAY;
import static org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE;

@Service
public class OpenAiChatService {

    private static final int MAX_HISTORY = 10;
    private static final int MAX_DOCUMENT_TEXT = 20_000;
    private static final int DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;

    private final RestClient restClient;
    private final String apiKey;
    private final String model;

    public OpenAiChatService(
            RestClient.Builder restClientBuilder,
            @Value("${openai.api-key:}") String apiKey,
            @Value("${openai.model:gpt-5.6-luna}") String model) {
        this.restClient = restClientBuilder.baseUrl("https://api.openai.com/v1").build();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.model = model;
    }

    public String chat(ChatController.ChatRequest request) {
        if (apiKey.isBlank()) {
            throw new ResponseStatusException(
                    SERVICE_UNAVAILABLE,
                    "OPENAI_API_KEY가 설정되지 않았습니다. 백엔드 환경변수에 API Key를 설정해주세요."
            );
        }

        String rawDocumentText = request.documentText() == null ? "" : request.documentText();
        System.out.println("[Chat] documentName=" + safeLogValue(request.documentName()));
        System.out.println("[Chat] documentType=" + safeLogValue(request.documentType()));
        System.out.println("[Chat] documentTextLength=" + rawDocumentText.length());

        LimitedDocumentText limitedDocument = limitDocumentText(rawDocumentText);

        List<Map<String, Object>> input = new ArrayList<>();
        input.add(message("developer",
                "너는 DocPilot의 문서 작업 보조 AI다. " +
                "사용자가 문서를 선택한 경우 제공된 문서 텍스트를 우선 기준으로 답변한다. " +
                "문서에 없는 내용은 추측하지 말고 '문서에서 확인되지 않습니다'라고 답한다. " +
                "문서 내용을 요약하거나 질문에 답할 때 페이지 표시가 제공되어 있으면 가능한 경우 페이지를 함께 언급한다. " +
                "문서 수정이 필요한 경우 직접 수정했다고 말하지 말고 수정 제안만 한다. " +
                "실제 수정은 DocPilot의 검색, 위치 하이라이트, 즉시 텍스트 교체 기능을 통해 사용자가 실행해야 한다. " +
                "문서 텍스트가 제공되지 않은 경우에는 일반 질문과 DocPilot 사용 관련 질문에 답할 수 있다."));

        String documentContext = buildDocumentContext(request, limitedDocument);
        if (!documentContext.isBlank()) {
            input.add(message("developer", documentContext));
        }

        List<ChatController.ChatMessage> history = request.history() == null
                ? List.of()
                : request.history();
        int fromIndex = Math.max(0, history.size() - MAX_HISTORY);

        for (ChatController.ChatMessage item : history.subList(fromIndex, history.size())) {
            if (item == null || item.content() == null || item.content().isBlank()) {
                continue;
            }
            String role = "assistant".equals(item.role()) ? "assistant" : "user";
            input.add(message(role, item.content().trim()));
        }

        if (input.stream().noneMatch(item -> "user".equals(item.get("role")))) {
            input.add(message("user", request.message().trim()));
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("store", false);
        body.put("input", input);

        try {
            JsonNode response = restClient.post()
                    .uri("/responses")
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("Authorization", "Bearer " + apiKey)
                    .body(body)
                    .retrieve()
                    .body(JsonNode.class);

            String answer = extractOutputText(response);
            if (answer.isBlank()) {
                throw new ResponseStatusException(BAD_GATEWAY, "OpenAI 응답에서 텍스트를 찾지 못했습니다.");
            }
            return answer;
        } catch (ResponseStatusException error) {
            throw error;
        } catch (Exception error) {
            throw new ResponseStatusException(BAD_GATEWAY, "OpenAI API 호출에 실패했습니다.", error);
        }
    }

    private String buildDocumentContext(ChatController.ChatRequest request, LimitedDocumentText limitedDocument) {
        StringBuilder context = new StringBuilder();
        context.append("아래는 현재 DocPilot에서 열린 문서의 컨텍스트다.\n");
        context.append("문서명: ").append(safePromptValue(request.documentName())).append('\n');
        context.append("문서 유형: ").append(safePromptValue(request.documentType())).append('\n');

        if (limitedDocument.text().isBlank()) {
            context.append("문서 내용: 현재 선택된 문서 내용은 전달되지 않았습니다.");
            return context.toString();
        }

        context.append("문서 내용:\n").append(limitedDocument.text());
        if (limitedDocument.truncated()) {
            context.append("\n\n[문서가 길어 앞부분과 뒷부분만 AI에 전달되었습니다. 중간 내용은 현재 컨텍스트에 포함되지 않았습니다.]");
        }
        return context.toString().trim();
    }

    private LimitedDocumentText limitDocumentText(String text) {
        if (text == null || text.isBlank()) {
            return new LimitedDocumentText("", false);
        }

        if (text.length() <= MAX_DOCUMENT_TEXT) {
            return new LimitedDocumentText(text, false);
        }

        String limited = text.substring(0, DOCUMENT_EDGE_LENGTH)
                + "\n\n[... 문서 중간 내용 생략 ...]\n\n"
                + text.substring(text.length() - DOCUMENT_EDGE_LENGTH);
        return new LimitedDocumentText(limited, true);
    }

    private String safeLogValue(String value) {
        if (value == null) {
            return "";
        }
        return value.replaceAll("[\\r\\n]", " ").trim();
    }

    private String safePromptValue(String value) {
        return value == null || value.isBlank() ? "없음" : value.trim();
    }

    private Map<String, Object> message(String role, String content) {
        return Map.of("role", role, "content", content);
    }

    private String extractOutputText(JsonNode response) {
        if (response == null) {
            return "";
        }

        JsonNode output = response.path("output");
        if (!output.isArray()) {
            return "";
        }

        StringBuilder text = new StringBuilder();
        for (JsonNode item : output) {
            JsonNode content = item.path("content");
            if (!content.isArray()) {
                continue;
            }
            for (JsonNode part : content) {
                if ("output_text".equals(part.path("type").asText())) {
                    String value = part.path("text").asText("");
                    if (!value.isBlank()) {
                        if (!text.isEmpty()) {
                            text.append('\n');
                        }
                        text.append(value);
                    }
                }
            }
        }
        return text.toString().trim();
    }

    private record LimitedDocumentText(String text, boolean truncated) {}
}
