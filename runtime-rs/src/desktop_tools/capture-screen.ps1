Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$captureBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$captureBitmap = New-Object System.Drawing.Bitmap $captureBounds.Width, $captureBounds.Height
$captureGraphics = $null
$captureStream = $null
try {
  $captureGraphics = [System.Drawing.Graphics]::FromImage($captureBitmap)
  $captureGraphics.CopyFromScreen($captureBounds.Location, [System.Drawing.Point]::Empty, $captureBounds.Size)
  $captureStream = New-Object System.IO.MemoryStream
  $captureBitmap.Save($captureStream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  [System.Convert]::ToBase64String($captureStream.ToArray())
} finally {
  if ($captureGraphics) { $captureGraphics.Dispose() }
  if ($captureBitmap) { $captureBitmap.Dispose() }
  if ($captureStream) { $captureStream.Dispose() }
}
