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
    private static final int MAX_DOCUMENT_TEXT = 30_000;

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

        List<Map<String, Object>> input = new ArrayList<>();
        input.add(message("developer",
                "당신은 DocPilot AI입니다. 사용자의 일반 질문에 한국어로 명확하고 실용적으로 답하세요. " +
                "현재는 일반 챗봇 1차 연결 단계이며, 문서 편집 동작을 직접 수행했다고 주장하지 마세요."));

        String documentContext = buildDocumentContext(request);
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

    private String buildDocumentContext(ChatController.ChatRequest request) {
        StringBuilder context = new StringBuilder();
        if (request.documentName() != null && !request.documentName().isBlank()) {
            context.append("현재 선택된 문서명: ").append(request.documentName().trim()).append('\n');
        }
        if (request.documentType() != null && !request.documentType().isBlank()) {
            context.append("현재 뷰어 유형: ").append(request.documentType().trim()).append('\n');
        }

        // 1차 연결에서도 인터페이스는 유지하되, 텍스트가 준비된 경우에만 제한적으로 컨텍스트에 포함한다.
        if (request.documentText() != null && !request.documentText().isBlank()) {
            String text = request.documentText().length() > MAX_DOCUMENT_TEXT
                    ? request.documentText().substring(0, MAX_DOCUMENT_TEXT)
                    : request.documentText();
            context.append("현재 문서에서 추출된 텍스트(일부):\n").append(text);
        }
        return context.toString().trim();
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
}
