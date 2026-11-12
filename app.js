// Identificador único deste navegador nesta sessão
const myClientId = "user_" + Math.random().toString(36).substring(2, 9);
const joinedAt = Date.now();

// Obter ou criar código de sala na URL (?sala=XYZ)
const urlParams = new URLSearchParams(window.location.search);
let roomCode = urlParams.get("sala");
if (!roomCode) {
  roomCode = "HT-" + Math.floor(1000 + Math.random() * 9000);
  window.history.replaceState({}, "", "?sala=" + roomCode);
}
document.getElementById("roomDisplay").textContent = roomCode;

// Estado da sessão
let myRole = null; // 'editor' ou 'approver'
let activePeers = {}; // { clientId: joinedAt }
let approvals = [];

// Ligar ao Broker WebSocket Público (sem backend e sem API keys)
const topic = `happytails/prototipo/docs/${roomCode}`;
const client = mqtt.connect("wss://broker.emqx.io:8084/mqtt");

client.on("connect", () => {
  document.getElementById("wsStatus").textContent = "🟢 Ligado em tempo real";
  client.subscribe(topic);

  // Anunciar entrada na sala
  activePeers[myClientId] = joinedAt;
  publicarMensagem({ type: "JOIN", clientId: myClientId, joinedAt: joinedAt });

  // Aguardar 800ms para verificar se já existe alguém na sala antes de assumir o papel
  setTimeout(() => {
    determinarPapel();
  }, 800);
});

client.on("message", (receivedTopic, payload) => {
  if (receivedTopic !== topic) return;
  const msg = JSON.parse(payload.toString());

  // 1. Alguém entrou na sala
  if (msg.type === "JOIN") {
    activePeers[msg.clientId] = msg.joinedAt;
    atualizarContadorOnline();

    // Se eu já estou na sala há mais tempo, respondo com a minha presença e estado atual do doc
    if (msg.clientId !== myClientId) {
      publicarMensagem({ type: "PRESENCE", clientId: myClientId, joinedAt: joinedAt });
      if (myRole === "editor") {
        transmitirEstado();
        publicarMensagem({ type: "SYNC_APPROVALS", approvals: approvals });
      }
    }
  }

  // 2. Resposta de presença de quem já cá estava
  if (msg.type === "PRESENCE") {
    activePeers[msg.clientId] = msg.joinedAt;
    atualizarContadorOnline();
    determinarPapel();
  }

  // 3. Atualização do conteúdo do documento (vinda da Editora)
  if (msg.type === "DOC_UPDATE" && myRole === "approver") {
    document.getElementById("docTitle").value = msg.title;
    definirConteudoDocumento(msg.content);
  }

  // 4. Nova aprovação ou pedido de revisão
  if (msg.type === "APPROVAL") {
    approvals.push(msg.data);
    renderizarAprovacoes();
  }

  // 5. Sincronização inicial de aprovações para quem entra depois
  if (msg.type === "SYNC_APPROVALS" && myRole === "approver") {
    approvals = msg.approvals;
    renderizarAprovacoes();
  }
});

// Decide quem é a 1ª pessoa (Editora) e quem são as seguintes (Participantes)
function determinarPapel() {
  const sortedIds = Object.keys(activePeers).sort((a, b) => activePeers[a] - activePeers[b]);
  const firstPersonId = sortedIds[0];

  const novoPapel = (firstPersonId === myClientId) ? "editor" : "approver";
  if (myRole === novoPapel) return;

  myRole = novoPapel;
  const badge = document.getElementById("roleBadge");
  const editorDiv = document.getElementById("editor");

  if (myRole === "editor") {
    badge.textContent = "✍️ Editora (1.º Acesso)";
    badge.className = "badge badge-editor";
    document.getElementById("editorToolbar").style.display = "flex";
    document.getElementById("approverBar").style.display = "none";
    document.getElementById("approverNameGate").style.display = "none";
    editorDiv.setAttribute("contenteditable", "true");
    definirConteudoDocumento(`
      <h1>ATA DE REUNIÃO</h1>
      <p><strong>Data:</strong> ${new Date().toLocaleDateString('pt-PT')} &nbsp;|&nbsp; <strong>Local:</strong> Coimbra</p>
      <p><br></p>
      <p>Escreva aqui o texto da ata. As outras pessoas que abrirem o link vão acompanhar em direto...</p>
    `);
  } else {
    badge.textContent = "👥 Participante";
    badge.className = "badge badge-approver";
    document.getElementById("editorToolbar").style.display = "none";
    document.getElementById("approverBar").style.display = "flex";
    document.getElementById("approverNameGate").style.display = "flex";
    editorDiv.setAttribute("contenteditable", "false");
    document.getElementById("approverNameEntry").focus();
  }
}

function atualizarContadorOnline() {
  const total = Object.keys(activePeers).length;
  document.getElementById("usersCount").textContent = `👥 ${total} online`;
}

function alternarBarraLateral() {
  const workspace = document.querySelector(".workspace");
  const toggle = document.getElementById("sidebarToggle");
  const mostrar = toggle.getAttribute("aria-expanded") !== "true";

  workspace.classList.toggle("show-sidebar", mostrar);
  toggle.setAttribute("aria-expanded", String(mostrar));
  toggle.textContent = mostrar
    ? "Ocultar estado da sessão e aprovações"
    : "Mostrar estado da sessão e aprovações";
}

function definirConteudoDocumento(html) {
  const sheets = document.querySelectorAll(".a4-sheet");
  const firstSheet = sheets[0];
  const stampArea = document.getElementById("docApprovalsStamp");

  Array.from(sheets).slice(1).forEach(sheet => sheet.remove());
  moverCarimbosParaPagina(stampArea, firstSheet);
  document.getElementById("editor").innerHTML = html;
  paginarDocumento();
}

function criarPaginaDocumento() {
  const pageWrapper = document.querySelector(".page-wrapper");
  const firstSheet = pageWrapper.querySelector(".a4-sheet");
  const newSheet = firstSheet.cloneNode(true);
  const body = newSheet.querySelector(".document-body");
  const firstBody = document.getElementById("editor");

  body.removeAttribute("id");
  body.innerHTML = "";
  body.setAttribute("contenteditable", firstBody.getAttribute("contenteditable"));
  body.setAttribute("oninput", "transmitirEstado()");
  let stampPlaceholder = newSheet.querySelector(".doc-stamps");
  if (!stampPlaceholder) {
    stampPlaceholder = document.createElement("div");
    stampPlaceholder.className = "doc-stamps";
    newSheet.insertBefore(stampPlaceholder, newSheet.querySelector(".letterhead-footer"));
  }
  stampPlaceholder.removeAttribute("id");
  stampPlaceholder.innerHTML = "";
  pageWrapper.appendChild(newSheet);
  return body;
}

function moverCarimbosParaPagina(stampArea, sheet) {
  let placeholder = sheet.querySelector(".doc-stamps");
  if (!placeholder) {
    placeholder = document.createElement("div");
    placeholder.className = "doc-stamps";
    sheet.insertBefore(placeholder, sheet.querySelector(".letterhead-footer"));
  }
  if (placeholder === stampArea) return;

  if (stampArea.parentNode) {
    const emptyArea = document.createElement("div");
    emptyArea.className = "doc-stamps";
    stampArea.parentNode.replaceChild(emptyArea, stampArea);
  }
  placeholder.replaceWith(stampArea);
}

function dividirBlocoExcedente(body) {
  const block = body.querySelector(":scope > :last-child");
  if (!block) return false;

  const pageBottom = body.getBoundingClientRect().bottom -
    parseFloat(getComputedStyle(block).marginBottom) - 2;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let splitNode = null;
  let splitOffset = 0;
  let textNode;

  while ((textNode = walker.nextNode()) && !splitNode) {
    const words = /\S+/g;
    let word;
    while ((word = words.exec(textNode.textContent))) {
      const range = document.createRange();
      range.setStart(textNode, word.index);
      range.setEnd(textNode, word.index + word[0].length);
      if (range.getBoundingClientRect().bottom > pageBottom) {
        splitNode = textNode;
        splitOffset = word.index;
        break;
      }
    }
  }

  if (!splitNode) return false;

  const splitRange = document.createRange();
  splitRange.setStart(splitNode, splitOffset);
  splitRange.setEndAfter(block.lastChild);
  const selection = window.getSelection();
  const moveCaret = selection && selection.rangeCount &&
    block.contains(selection.focusNode) &&
    splitRange.comparePoint(selection.focusNode, selection.focusOffset) >= 0;
  const continuationContent = splitRange.extractContents();
  if (!continuationContent.textContent.trim()) return false;

  const continuation = block.cloneNode(false);
  continuation.appendChild(continuationContent);
  body.appendChild(continuation);

  if (moveCaret) {
    const caret = document.createRange();
    caret.selectNodeContents(continuation);
    caret.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
  return true;
}

function paginarDocumento() {
  const pageWrapper = document.querySelector(".page-wrapper");
  const stampArea = document.getElementById("docApprovalsStamp");
  const wasEditing = document.activeElement.classList.contains("document-body");
  let sheets = Array.from(pageWrapper.querySelectorAll(".a4-sheet"));
  let hasOverflow;

  do {
    moverCarimbosParaPagina(stampArea, sheets[sheets.length - 1]);
    hasOverflow = false;

    for (let index = 0; index < sheets.length; index += 1) {
      const body = sheets[index].querySelector(".document-body");
      while (body.scrollHeight > body.clientHeight) {
        const contentNodes = Array.from(body.childNodes).filter(node =>
          node.nodeType !== Node.TEXT_NODE || node.textContent.trim()
        );
        if (contentNodes.length === 1 && dividirBlocoExcedente(body)) {
          hasOverflow = true;
          continue;
        }
        if (contentNodes.length < 2) break;

        let nextSheet = sheets[index + 1];
        if (!nextSheet) {
          criarPaginaDocumento();
          sheets = Array.from(pageWrapper.querySelectorAll(".a4-sheet"));
          nextSheet = sheets[index + 1];
        }

        const nextBody = nextSheet.querySelector(".document-body");
        const overflowNode = contentNodes[contentNodes.length - 1];
        const selection = window.getSelection();
        const cursor = wasEditing && selection && selection.rangeCount &&
          overflowNode.contains(selection.focusNode)
          ? { node: selection.focusNode, offset: selection.focusOffset }
          : null;

        nextBody.insertBefore(overflowNode, nextBody.firstChild);
        if (cursor && cursor.node.isConnected) {
          nextBody.focus();
          const caret = document.createRange();
          const maxOffset = cursor.node.nodeType === Node.TEXT_NODE
            ? cursor.node.length
            : cursor.node.childNodes.length;
          caret.setStart(cursor.node, Math.min(cursor.offset, maxOffset));
          caret.collapse(true);
          selection.removeAllRanges();
          selection.addRange(caret);
        }
        hasOverflow = true;
      }
    }

    sheets = Array.from(pageWrapper.querySelectorAll(".a4-sheet"));
  } while (hasOverflow);

  while (sheets.length > 1 && !sheets[sheets.length - 1].querySelector(".document-body").hasChildNodes()) {
    sheets.pop().remove();
  }
  moverCarimbosParaPagina(stampArea, sheets[sheets.length - 1]);

  if (wasEditing) {
    const selection = window.getSelection();
    const focusedBody = selection && selection.anchorNode &&
      Array.from(pageWrapper.querySelectorAll(".document-body"))
        .find(body => body.contains(selection.anchorNode));
    if (focusedBody && document.activeElement !== focusedBody) focusedBody.focus();
  }
}

// Envia o texto escrito pela Editora em tempo real
function transmitirEstado() {
  if (myRole !== "editor") return;
  paginarDocumento();
  publicarMensagem({
    type: "DOC_UPDATE",
    title: document.getElementById("docTitle").value,
    content: Array.from(document.querySelectorAll(".page-wrapper .document-body"))
      .map(body => body.innerHTML)
      .join("")
  });
}

// Envia decisão do Participante
function enviarDecisao(status) {
  const nome = document.getElementById("approverName").value.trim();
  if (!nome) return;
  const nota = document.getElementById("approverNote").value.trim();

  const registo = {
    nome: nome,
    status: status,
    nota: nota,
    hora: new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })
  };

  publicarMensagem({ type: "APPROVAL", data: registo });
  document.getElementById("approverNote").value = "";
}

function confirmarNomeParticipante(event) {
  event.preventDefault();
  const nome = document.getElementById("approverNameEntry").value.trim();
  if (!nome) {
    document.getElementById("approverNameEntry").focus();
    return false;
  }

  document.getElementById("approverName").value = nome;
  document.getElementById("approverNameGate").style.display = "none";
  return false;
}

function renderizarAprovacoes() {
  const list = document.getElementById("approvalsList");
  const stampArea = document.getElementById("docApprovalsStamp");
  list.innerHTML = "";
  stampArea.innerHTML = "";

  if (approvals.length === 0) {
    list.innerHTML = `<li class="empty-msg">Nenhuma aprovação registada ainda.</li>`;
    return;
  }

  approvals.forEach(item => {
    const li = document.createElement("li");
    if (item.status !== "APROVADO") li.classList.add("rejected");
    li.innerHTML = `
      <strong>${item.status === "APROVADO" ? "✅" : "⚠️"} ${item.nome}</strong> (${item.hora})<br>
      <span>${item.status}${item.nota ? " — " + item.nota : ""}</span>
    `;
    list.appendChild(li);

    if (item.status === "APROVADO") {
      const stamp = document.createElement("div");
      stamp.className = "stamp-box";
      stamp.textContent = `✔ Aprovado por ${item.nome} às ${item.hora}`;
      stampArea.appendChild(stamp);
    }
  });
}

function publicarMensagem(obj) {
  if (client && client.connected) {
    client.publish(topic, JSON.stringify(obj));
  }
}

function execCmd(command, value = null) {
  document.execCommand(command, false, value);
  transmitirEstado();
}

function abrirDialogoConvite() {
  const dialog = document.getElementById("inviteDialog");
  const inviteUrl = window.location.href;
  const qrContainer = document.getElementById("inviteQrCode");
  const status = document.getElementById("inviteStatus");

  document.getElementById("inviteLink").value = inviteUrl;
  qrContainer.replaceChildren();
  status.textContent = "";
  dialog.showModal();

  if (typeof QRCode === "undefined") {
    status.textContent = "Não foi possível carregar o gerador do QR Code. Pode partilhar o link acima.";
    return;
  }

  new QRCode(qrContainer, {
    text: inviteUrl,
    width: 220,
    height: 220,
    colorDark: "#3A1700",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

async function copiarLinkConvite() {
  const inviteLink = document.getElementById("inviteLink");
  const status = document.getElementById("inviteStatus");

  try {
    await navigator.clipboard.writeText(inviteLink.value);
    status.textContent = "Link copiado. Envie-o ao participante.";
  } catch (error) {
    inviteLink.focus();
    inviteLink.select();
    status.textContent = "Não foi possível copiar automaticamente. Selecione e copie o link acima.";
  }
}

function exportarPDF() {
  window.print();
}
