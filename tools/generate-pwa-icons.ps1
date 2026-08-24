Add-Type -AssemblyName System.Drawing

function New-MeowneyIcon([int]$size, [string]$path) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#111315'))
  $scale = $size / 512.0
  $mint = [System.Drawing.ColorTranslator]::FromHtml('#8ee7c1')
  $ink = [System.Drawing.ColorTranslator]::FromHtml('#083526')
  $face = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $face.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(141 * $scale, 179 * $scale), [System.Drawing.PointF]::new(187 * $scale, 94 * $scale),
    [System.Drawing.PointF]::new(256 * $scale, 141 * $scale), [System.Drawing.PointF]::new(325 * $scale, 94 * $scale),
    [System.Drawing.PointF]::new(371 * $scale, 179 * $scale), [System.Drawing.PointF]::new(371 * $scale, 356 * $scale),
    [System.Drawing.PointF]::new(293 * $scale, 434 * $scale), [System.Drawing.PointF]::new(219 * $scale, 434 * $scale),
    [System.Drawing.PointF]::new(141 * $scale, 356 * $scale)
  ))
  $graphics.FillPath([System.Drawing.SolidBrush]::new($mint), $face)
  $pen = [System.Drawing.Pen]::new($ink, 18 * $scale)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc($pen, 171 * $scale, 187 * $scale, 170 * $scale, 112 * $scale, 197, 146)
  $graphics.FillEllipse([System.Drawing.SolidBrush]::new($ink), 191 * $scale, 250 * $scale, 28 * $scale, 28 * $scale)
  $graphics.FillEllipse([System.Drawing.SolidBrush]::new($ink), 293 * $scale, 250 * $scale, 28 * $scale, 28 * $scale)
  $graphics.FillEllipse([System.Drawing.SolidBrush]::new($ink), 233 * $scale, 286 * $scale, 46 * $scale, 33 * $scale)
  $graphics.DrawLine($pen, 256 * $scale, 319 * $scale, 256 * $scale, 353 * $scale)
  $graphics.DrawArc($pen, 213 * $scale, 321 * $scale, 43 * $scale, 32 * $scale, 0, 90)
  $graphics.DrawArc($pen, 256 * $scale, 321 * $scale, 43 * $scale, 32 * $scale, 90, 90)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $face.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

$outputDirectory = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
New-MeowneyIcon 192 (Join-Path $outputDirectory 'meowney-192.png')
New-MeowneyIcon 512 (Join-Path $outputDirectory 'meowney-512.png')
