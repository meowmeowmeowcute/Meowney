Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $PSScriptRoot '..\icons'
$sourcePath = Join-Path $outputDirectory 'meowney-512.png'
$targetPath = Join-Path $outputDirectory 'meowney-192.png'

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "找不到應用程式主圖示：$sourcePath"
}

$source = [System.Drawing.Image]::FromFile($sourcePath)
$target = [System.Drawing.Bitmap]::new(192, 192)
$graphics = [System.Drawing.Graphics]::FromImage($target)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($source, 0, 0, 192, 192)
$target.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $target.Dispose(); $source.Dispose()
