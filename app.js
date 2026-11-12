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
    document.getElementById("editor").innerHTML = msg.content;
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

// Decide quem é a 1ª pessoa (Editora) e quem são as seguintes (Visualizador/Aprovador)
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
    editorDiv.setAttribute("contenteditable", "true");
    editorDiv.innerHTML = `
      <h1>ATA DE REUNIÃO</h1>
      <p><strong>Data:</strong> ${new Date().toLocaleDateString('pt-PT')} &nbsp;|&nbsp; <strong>Local:</strong> Coimbra</p>
      <p><br></p>
      <p>Escreva aqui o texto da ata. As outras pessoas que abrirem o link vão acompanhar em direto...</p>
    `;
  } else {
    badge.textContent = "👁️ Visualizador & Aprovador";
    badge.className = "badge badge-approver";
    document.getElementById("editorToolbar").style.display = "none";
    document.getElementById("approverBar").style.display = "flex";
    editorDiv.setAttribute("contenteditable", "false");
  }
}

function atualizarContadorOnline() {
  const total = Object.keys(activePeers).length;
  document.getElementById("usersCount").textContent = `👥 ${total} online`;
}

// Envia o texto escrito pela Editora em tempo real
function transmitirEstado() {
  if (myRole !== "editor") return;
  publicarMensagem({
    type: "DOC_UPDATE",
    title: document.getElementById("docTitle").value,
    content: document.getElementById("editor").innerHTML
  });
}

// Envia decisão do Visualizador/Aprovador
function enviarDecisao(status) {
  const nome = document.getElementById("approverName").value.trim() || "Aprovador Anónimo";
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

function copiarLinkConvite() {
  navigator.clipboard.writeText(window.location.href);
  alert("Link da sala copiado! Envia este link à 2.ª pessoa para entrar como Visualizador/Aprovador:\n\n" + window.location.href);
}

function exportarPDF() {
  window.print();
}
