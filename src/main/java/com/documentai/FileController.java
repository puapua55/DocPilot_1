package com.documentai;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.UrlResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/files")
public class FileController {

    private final Path uploadDir;

    public FileController(@Value("${docpilot.upload-dir:uploads}") String uploadDir) {
        this.uploadDir = Paths.get(uploadDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.uploadDir);
        } catch (IOException e) {
            throw new IllegalStateException("Could not create upload directory", e);
        }
    }

    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> upload(@RequestParam("file") MultipartFile file) throws IOException {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("업로드할 파일이 없습니다.");
        }

        String originalName = file.getOriginalFilename();
        String extension = getExtension(originalName);
        String fileType = resolveFileType(extension, file.getContentType());
        String storedName = UUID.randomUUID() + "." + extension;

        Path target = this.uploadDir.resolve(storedName);
        Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);

        String viewPath = "/api/files/view/" + storedName;

        return Map.of(
            "fileName", originalName,
            "storedFileName", storedName,
            "fileType", fileType,
            "fileUrl", viewPath
        );
    }

    @GetMapping("/view/{fileName}")
    public ResponseEntity<Resource> view(@PathVariable String fileName) throws IOException {
        Path filePath = this.uploadDir.resolve(fileName).normalize();
        if (!filePath.startsWith(this.uploadDir)) {
            return ResponseEntity.notFound().build();
        }
        if (!Files.exists(filePath)) {
            return ResponseEntity.notFound().build();
        }

        Resource resource = new UrlResource(filePath.toUri());
        String extension = getExtension(fileName);
        MediaType mediaType = resolveMediaType(extension);

        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + fileName + "\"")
            .contentType(mediaType)
            .body(resource);
    }

    private String getExtension(String fileName) {
        if (fileName == null) {
            return "";
        }
        int lastDot = fileName.lastIndexOf('.');
        return lastDot >= 0 ? fileName.substring(lastDot + 1).toLowerCase() : "";
    }

    private String resolveFileType(String extension, String contentType) {
        if ("pdf".equalsIgnoreCase(extension) || "application/pdf".equalsIgnoreCase(contentType)) {
            return "pdf";
        }
        if ("doc".equalsIgnoreCase(extension) || "docx".equalsIgnoreCase(extension)) {
            return "word";
        }
        return extension.isEmpty() ? "unknown" : extension;
    }

    private MediaType resolveMediaType(String extension) {
        return switch (extension) {
            case "pdf" -> MediaType.APPLICATION_PDF;
            case "doc" -> MediaType.valueOf("application/msword");
            case "docx" -> MediaType.valueOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            default -> MediaType.APPLICATION_OCTET_STREAM;
        };
    }
}
