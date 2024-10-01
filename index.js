const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const cors = require('cors');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const axios = require('axios');
const pdfPoppler = require('pdf-poppler');
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function extractTextFromFile(file) {
  if (file.mimetype === 'application/pdf') {
    const dataBuffer = fs.readFileSync(file.path);
    const data = await pdf(dataBuffer);
    return data.text;
  } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({path: file.path});
    return result.value;
  } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const workbook = XLSX.readFile(file.path);
    let result = '';
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      result += XLSX.utils.sheet_to_txt(worksheet) + '\n\n';
    });
    return result;
  }
  throw new Error('Formato de archivo no soportado');
}

async function analizarDocumentos(contenidoSchema, contenidoOtrosDocumentos, apiChoice, archivosInfo) {
  if (apiChoice === 'claude') {
    return analizarDocumentosConClaude(contenidoSchema, contenidoOtrosDocumentos, archivosInfo);
  } else if (apiChoice === 'openai') {
    return analizarDocumentosConOpenAI(contenidoSchema, contenidoOtrosDocumentos);
  } else {
    throw new Error('Opción de API no válida');
  }
}

async function analizarDocumentosConClaude(contenidoSchema, contenidoOtrosDocumentos, archivosInfo) {
  try {
    let prompt = `Analiza el siguiente schema y los documentos relacionados. Para cada punto, proporciona un análisis detallado y asigna una gravedad (sin_problemas, problemas_leves, problemas_graves):

1) Consistencia del nombre del cliente (acreedor en la factura) y del deudor en todos los documentos.
2) Coherencia en los montos totales. Necesariamente tienes que haber visto facturas que contengan montos que en total coincidan con "Total Negocio" en el schema. Si no es así, coméntalo. En caso que el "Total Negocio" del schema sea mayor que el "Saldo a Girar" de; schmema, comenta que falta aclarar esa diferencia, la que puede deberse a que se esté neteando una deuda previa del cliente por la diferencia, lo que tiene que ser confirmado. Alternativamente, verifica que la diferencia de montos no se deba a otro motivo, como que alguna de la facturas presdentadas fue retirada de la operación o bajada (o palabras similares), lo que usualmente se menciona en los comentarios del schema. Si es posible con la información provista determinar cuál es la factura que se baja o saca de la operación y su monto, entonces haz el cálculo y si entonces el "Total Negocio" coincide con el monto total de las facturas no sacadas o bajadas, todo está ok. Si no te es posible hacer ese cálculo, explícalo junto con el motivo (por ejemplo, que en los comentarios se menciona que se baja una factura pero no se singulariza suficientemente como para saber cuál es ni su monto). El "Saldo a Girar" nunca debería ser superior al "Total Negocio", si fuera el caso, coméntalo como un problema grave.
 
3) Consistencia de las glosas de las facturas con el giro de la sociedad emisora (según la factura y/o el schema).
4) Coincidencia de los números de factura entre los distintos documentos. Por ejemplo, podría haber un docuemnto con una nómiona de facturas y en tal caso, los números mencionados tienen que coincidir con los números en las facturas mismas. Lo mismo si se menciona el número de la factura en un correo electrónico o en otro documento.
5) Existencia de potenciales comentarios que indiquen que la operación no está lista para ser cursada. En tal caso, verifica si comentarios posteriores parecieran solucionar el problema planteado o aprobar la operación.
6) Existencia de posibles elementos sospechosos o incoherentes entre los documentos. Por ejemplo, que se hayan subido facturas u otros documentos que parezcan adulterados, modificados de manera irregular, con formato no profesional, que tengan elementos importantes en blanco, etc.

Schema:
${contenidoSchema}

Otros documentos:
${contenidoOtrosDocumentos}

Proporciona el análisis en el siguiente formato JSON. NO INCLUYES NADA MÁS QUE EL JSON. 
{
  "resultados": [
    {
      "numero": "1",
      "analisis": "...",
      "gravedad": "sin_problemas|problemas_leves|problemas_graves"
    },
    // ... (repite para cada punto)
  ],
  "conclusion": "..."
}`;

    let messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt }
        ]
      }
    ];

    // Agregar imágenes si es necesario
    archivosInfo.forEach(archivo => {
      if (archivo.digitalizacion === 'Escaneado' && archivo.imagen) {
        const imagePath = path.join(__dirname, 'public', archivo.imagen);
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        
        messages[0].content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: base64Image
          }
        });
      }
    });

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 8192,
      temperature: 0,
      messages: messages
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.CLAUDE_API_KEY
      }
    });

    const completion = response.data.content[0]?.text || '';

    return completion.trim();
  } catch (error) {
    console.error('Error en analizarDocumentosConClaude:', error.response ? error.response.data : error.message);
    throw new Error(`Error al analizar documentos con Claude: ${error.message}`);
  }
}

async function analizarDocumentosConOpenAI(contenidoSchema, contenidoOtrosDocumentos) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        { role: "system", content: "Eres un asistente experto en análisis de facturas y documentos relacionados. Debes verificar la coherencia entre el documento 'schema.docx' y los demás documentos de la operación." },
        { role: "user", content: `Analiza el siguiente schema y los documentos relacionados. Para cada punto, proporciona un análisis detallado y asigna una gravedad (sin_problemas, problemas_leves, problemas_graves):

          1) Consistencia del nombre del cliente y del deudor en todos los documentos.
          2) Coherencia en los montos totales.
          3) Consistencia de las glosas de las facturas con el giro de la sociedad emisora (según la factura y/o el schema).
          4) Coincidencia de los números de factura.
          5) Existencia de potenciales comentarios que indiquen que la operación no está lista para ser cursada.
          6) Existencia de posibles elementos sospechosos o incoherentes entre los documentos.

          Schema:
          ${contenidoSchema}

          Otros documentos:
          ${contenidoOtrosDocumentos}

          Proporciona el análisis en el siguiente formato JSON:
          {
            "resultados": [
              {
                "numero": "1",
                "analisis": "...",
                "gravedad": "sin_problemas|problemas_leves|problemas_graves"
              },
              // ... (repite para cada punto)
            ],
            "conclusion": "..."
          }` }
      ],
      temperature: 0,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error en analizarDocumentosConOpenAI:', error);
    throw new Error(`Error al analizar documentos con OpenAI: ${error.message}`);
  }
}

async function isDigitizedPDF(file) {
  if (file.mimetype !== 'application/pdf') {
    return null; // No es un PDF
  }

  try {
    const texto = await extractTextFromFile(file);
    // Si se pudo extraer texto, consideramos que está digitalizado
    return texto.trim().length > 0;
  } catch (error) {
    console.error('Error al verificar digitalización:', error);
    return false; // Si hay un error, asumimos que no está digitalizado
  }
}

app.post('/analizar-facturas', upload.array('archivos'), async (req, res) => {
  try {
    let contenidoSchema = '';
    let contenidoOtrosDocumentos = '';
    let archivosInfo = [];

    // Añade este log para ver todos los archivos recibidos
    console.log('Archivos recibidos:', req.files.map(f => f.originalname));

    // Procesamos todos los archivos recibidos
    for (const file of req.files) {
      const contenidoArchivo = await extractTextFromFile(file);

      // Añade este log para ver el contenido de cada archivo
      console.log(`Contenido de ${file.originalname}:`, contenidoArchivo.substring(0, 200) + '...');

      if (file.originalname === 'schema.docx' || file.originalname === 'schema.xlsx') {
        contenidoSchema = contenidoArchivo;
      } else {
        contenidoOtrosDocumentos += contenidoArchivo + '\n\n';
      }

      let digitalizacionInfo = '';
      let imagen = null;
      if (file.mimetype === 'application/pdf') {
        const esDigitalizado = await isDigitizedPDF(file);
        digitalizacionInfo = esDigitalizado 
          ? 'Digital' 
          : 'Escaneado';

        if (!esDigitalizado) {
          // Convertir PDF a JPG
          const options = {
            format: 'jpeg',
            out_dir: path.join(__dirname, 'public', 'images'),
            out_prefix: path.parse(file.originalname).name,
            page: 1
          };

          // Asegúrate de que la carpeta 'public/images' exista
          if (!fs.existsSync(options.out_dir)){
            fs.mkdirSync(options.out_dir, { recursive: true });
          }

          try {
            await pdfPoppler.convert(file.path, options);
            imagen = `/images/${options.out_prefix}-${options.page}.jpg`;
          } catch (error) {
            console.error('Error al convertir PDF a JPG:', error);
          }
        }
      } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        digitalizacionInfo = 'Digital'; // Los archivos Excel siempre se consideran digitalizados
      }

      archivosInfo.push({
        nombre: file.originalname,
        digitalizacion: digitalizacionInfo,
        imagen: imagen // Añadimos la ruta de la imagen si existe
      });
    }

    // Añade este log para ver el contenido final que se enviará a la API
    console.log('Contenido del schema:', contenidoSchema.substring(0, 200) + '...');
    console.log('Contenido de otros documentos:', contenidoOtrosDocumentos.substring(0, 200) + '...');

    if (!contenidoSchema) {
      throw new Error('No se ha proporcionado el archivo schema.docx');
    }

    const apiChoice = req.body.apiChoice;
    if (!apiChoice || (apiChoice !== 'claude' && apiChoice !== 'openai')) {
      throw new Error('Opción de API no válida o no especificada');
    }

    const resultado = await analizarDocumentos(contenidoSchema, contenidoOtrosDocumentos, apiChoice, archivosInfo);

    // Asegúrate de que el resultado sea un objeto JSON válido
    let resultadoJSON;
    try {
      resultadoJSON = typeof resultado === 'string' ? JSON.parse(resultado) : resultado;
    } catch (error) {
      console.error('Error al parsear el resultado:', error);
      throw new Error('El resultado no es un JSON válido');
    }

    res.json({ 
      resultado: resultadoJSON,
      archivosInfo: archivosInfo
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ 
      resultado: { 
        resultados: [{ 
          numero: '0', 
          analisis: 'Error al procesar los documentos: ' + error.message, 
          gravedad: 'problemas_graves' 
        }], 
        conclusion: 'Error en el procesamiento' 
      },
      archivosInfo: []
    });
  } finally {
    // Eliminamos todos los archivos temporales
    if (req.files) {
      req.files.forEach(file => fs.unlinkSync(file.path));
    }
  }
});

app.get('/', (req, res) => {
  res.send('Bienvenido a la API de análisis de facturas');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));