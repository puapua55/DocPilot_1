$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $PSScriptRoot '..\electron\icon.png'
$windowsIconPath = Join-Path $PSScriptRoot '..\electron\icon.ico'
$browserIconPath = Join-Path $PSScriptRoot '..\public\favicon.ico'
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$source = [System.Drawing.Bitmap]::new($sourcePath)

try {
    $frames = foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.DrawImage($source, 0, 0, $size, $size)
            } finally {
                $graphics.Dispose()
            }

            $stream = [System.IO.MemoryStream]::new()
            try {
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                ,$stream.ToArray()
            } finally {
                $stream.Dispose()
            }
        } finally {
            $bitmap.Dispose()
        }
    }

    $file = [System.IO.File]::Create($windowsIconPath)
    try {
        $writer = [System.IO.BinaryWriter]::new($file)
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$sizes.Count)

        $offset = [uint32](6 + 16 * $sizes.Count)
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$frames[$i].Length)
            $writer.Write($offset)
            $offset += [uint32]$frames[$i].Length
        }

        foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    } finally {
        $file.Dispose()
    }

    Copy-Item -LiteralPath $windowsIconPath -Destination $browserIconPath -Force
} finally {
    $source.Dispose()
}
