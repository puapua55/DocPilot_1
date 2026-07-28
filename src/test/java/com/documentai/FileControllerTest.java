package com.documentai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "docpilot.upload-dir=target/test-uploads")
@AutoConfigureMockMvc
class FileControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() throws Exception {
        Path uploadDir = Path.of("target/test-uploads");
        if (Files.exists(uploadDir)) {
            Files.walk(uploadDir)
                .sorted((a, b) -> b.compareTo(a))
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (Exception ignored) {
                    }
                });
        }
        Files.createDirectories(uploadDir);
    }

    @Test
    void uploadAndViewPdf() throws Exception {
        MockMultipartFile file = new MockMultipartFile(
            "file",
            "sample.pdf",
            "application/pdf",
            "%PDF-1.4\n".getBytes(StandardCharsets.UTF_8)
        );

        MvcResult uploadResult = mockMvc.perform(multipart("/api/files/upload").file(file))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.fileName").value("sample.pdf"))
            .andExpect(jsonPath("$.fileType").value("pdf"))
            .andExpect(jsonPath("$.fileUrl").value(startsWith("/api/files/view/")))
            .andReturn();

        JsonNode response = objectMapper.readTree(uploadResult.getResponse().getContentAsString());
        String storedFileName = response.get("storedFileName").asText();

        mockMvc.perform(get("/api/files/view/{fileName}", storedFileName))
            .andExpect(status().isOk())
            .andExpect(result -> {
                String contentType = result.getResponse().getContentType();
                if (contentType == null || !contentType.contains("application/pdf")) {
                    throw new AssertionError("Expected PDF content type but was " + contentType);
                }
            });
    }
}
