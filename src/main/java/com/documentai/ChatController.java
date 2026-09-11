package com.documentai;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final OpenAiChatService openAiChatService;

    public ChatController(OpenAiChatService openAiChatService) {
        this.openAiChatService = openAiChatService;
    }

    @PostMapping
    public ChatResponse chat(@RequestBody ChatRequest request) {
        if (request == null || request.message() == null || request.message().trim().isEmpty()) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "message는 필수입니다.");
        }
        OpenAiChatService.ChatResult result = openAiChatService.chat(request);
        return new ChatResponse(result.answer(), result.intent(), result.action());
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handleResponseStatus(ResponseStatusException error) {
        String message = error.getReason() == null ? "AI 요청 처리 중 오류가 발생했습니다." : error.getReason();
        return ResponseEntity.status(error.getStatusCode()).body(Map.of("message", message));
    }

    public record ChatRequest(String message, String documentName, String documentType, String documentText, List<ChatMessage> history) {}
    public record ChatMessage(String role, String content) {}
    public record ChatAction(String type, String keyword, String originalText, String newText) {}
    public record ChatResponse(String answer, String intent, ChatAction action) {}
}
