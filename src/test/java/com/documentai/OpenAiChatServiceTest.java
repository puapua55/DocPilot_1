package com.documentai;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenAiChatServiceTest {

    @Test
    void documentInstructionsRequireGroundedAnswersAndNoDirectEditClaim() {
        String instructions = OpenAiChatService.documentAssistantInstructions();

        assertTrue(instructions.contains("최우선 근거"));
        assertTrue(instructions.contains("제공된 문서에서는 확인되지 않습니다"));
        assertTrue(instructions.contains("페이지 번호"));
        assertTrue(instructions.contains("직접 수정했다고 말하지 않는다"));
    }

    @Test
    void shortDocumentIsNotTruncated() {
        OpenAiChatService.LimitedDocumentText result =
                OpenAiChatService.limitDocumentText("[1페이지]\n테스트 문서");

        assertFalse(result.truncated());
        assertEquals("[1페이지]\n테스트 문서", result.text());
    }

    @Test
    void longDocumentKeepsHeadAndTailAndMarksTruncation() {
        String source = "A".repeat(10_001) + "MIDDLE".repeat(2_000) + "Z".repeat(10_001);

        OpenAiChatService.LimitedDocumentText result =
                OpenAiChatService.limitDocumentText(source);

        assertTrue(result.truncated());
        assertTrue(result.text().startsWith("A".repeat(100)));
        assertTrue(result.text().contains("문서 중간 내용 생략"));
        assertTrue(result.text().endsWith("Z".repeat(100)));
        assertTrue(OpenAiChatService.isDocumentTextTruncated(source));
    }

    @Test
    void truncatedDocumentContextWarnsThatOnlyPartialContentWasProvided() {
        String source = "앞".repeat(11_000) + "뒤".repeat(11_000);
        OpenAiChatService.LimitedDocumentText limited = OpenAiChatService.limitDocumentText(source);
        ChatController.ChatRequest request = new ChatController.ChatRequest(
                "요약해줘",
                "sample.pdf",
                "pdf",
                source,
                List.of()
        );

        String context = OpenAiChatService.buildDocumentContext(request, limited);

        assertTrue(context.contains("sample.pdf"));
        assertTrue(context.contains("제공된 일부 내용 기준"));
        assertTrue(context.contains("전체 문서를 본 것처럼 단정하지 말고"));
    }
}
