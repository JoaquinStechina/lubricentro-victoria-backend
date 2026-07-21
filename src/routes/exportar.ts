import type { Response } from "express";
import * as XLSX from "xlsx";

// Helpers compartidos por GET /api/productos/export y /api/ofertas/export.
// Reciben las filas ya consultadas (con los mismos where/orderBy que el GET
// de la tabla) como objetos {encabezado legible: valor} y responden el
// archivo entero en memoria — aceptable al volumen actual (decenas de miles
// de filas); si crece, el CSV se puede pasar a streaming.

export type FilaExport = Record<string, string | number | null>;

// CSV pensado para abrirse directo en Excel con configuración regional
// es-AR: separador ";" (la coma es el separador decimal), números con coma
// decimal, BOM para que Excel detecte UTF-8 y no rompa los acentos.
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const texto = typeof value === "number" ? String(value).replace(".", ",") : value;
  if (/[;"\n\r]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function toCsv(filas: FilaExport[], headers: string[]): string {
  const lineas = [headers.map(csvCell).join(";")];
  for (const fila of filas) {
    lineas.push(headers.map((h) => csvCell(fila[h] ?? null)).join(";"));
  }
  return "﻿" + lineas.join("\r\n");
}

// Valida ?formato= y manda el archivo con Content-Disposition. Devuelve
// false (y responde 400) si el formato no es csv ni xlsx — el caller corta.
export function enviarExport(
  res: Response,
  formato: unknown,
  nombreBase: string,
  headers: string[],
  filas: FilaExport[]
): void {
  const fecha = new Intl.DateTimeFormat("en-CA").format(new Date());
  if (formato === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nombreBase}-${fecha}.csv"`);
    res.send(toCsv(filas, headers));
    return;
  }
  if (formato === "xlsx") {
    const sheet = XLSX.utils.json_to_sheet(filas, { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, nombreBase);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${nombreBase}-${fecha}.xlsx"`);
    res.send(buffer);
    return;
  }
  res.status(400).json({ error: 'Falta ?formato=csv|xlsx en la query.' });
}
