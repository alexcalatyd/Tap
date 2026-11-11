import AppKit

// Dibuja el icono de la app (1024 px) y lo guarda como PNG.
// Uso: swift icon.swift salida.png

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let context = NSGraphicsContext.current!.cgContext
let space = CGColorSpaceCreateDeviceRGB()

// Placa: margen y radio de la plantilla de iconos de macOS.
let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: plate, cornerWidth: 186, cornerHeight: 186, transform: nil)

context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.32).cgColor)
context.addPath(shape)
context.setFillColor(NSColor(calibratedWhite: 0.12, alpha: 1).cgColor)
context.fillPath()
context.restoreGState()

// Grafito, un poco más claro arriba.
context.saveGState()
context.addPath(shape)
context.clip()
let body = CGGradient(colorsSpace: space, colors: [
    NSColor(calibratedRed: 0.235, green: 0.235, blue: 0.25, alpha: 1).cgColor,
    NSColor(calibratedRed: 0.09, green: 0.09, blue: 0.10, alpha: 1).cgColor,
] as CFArray, locations: [0, 1])!
context.drawLinearGradient(body, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
context.restoreGState()

// Filo interior muy tenue.
context.saveGState()
context.addPath(CGPath(roundedRect: plate.insetBy(dx: 2.5, dy: 2.5), cornerWidth: 183.5, cornerHeight: 183.5, transform: nil))
context.setStrokeColor(NSColor.white.withAlphaComponent(0.12).cgColor)
context.setLineWidth(5)
context.strokePath()
context.restoreGState()

// Flecha de descarga y su línea de base.
context.setStrokeColor(NSColor(calibratedWhite: 0.96, alpha: 1).cgColor)
context.setLineCap(.round)
context.setLineJoin(.round)
context.setLineWidth(54)
context.move(to: CGPoint(x: 512, y: 706))
context.addLine(to: CGPoint(x: 512, y: 432))
context.move(to: CGPoint(x: 392, y: 548))
context.addLine(to: CGPoint(x: 512, y: 428))
context.addLine(to: CGPoint(x: 632, y: 548))
context.move(to: CGPoint(x: 372, y: 318))
context.addLine(to: CGPoint(x: 652, y: 318))
context.strokePath()

image.unlockFocus()

let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
let png = bitmap.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
