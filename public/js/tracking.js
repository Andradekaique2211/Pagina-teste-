// Funções Helpers de Cookies
function setCookie(name, value, days) {
  let expires = "";
  if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "")  + expires + "; path=/";
}
function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for(let i=0;i < ca.length;i++) {
      let c = ca[i];
      while (c.charAt(0)==' ') c = c.substring(1,c.length);
      if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
  }
  return null;
}

document.addEventListener('DOMContentLoaded', () => {
  // 1. CAPTURAR E SALVAR AFILIADO (?ref=ID) via Cookies (60 dias) e LocalStorage
  const urlParams = new URLSearchParams(window.location.search);
  const ref = urlParams.get('ref');
  
  if (ref) {
    localStorage.setItem('affiliate_ref', ref);
    setCookie('affiliate_ref', ref, 60); // Persistência por 60 dias!
    console.log('Visita do Afiliado Salva (Cookies & Storage):', ref);
    
    // Registrar Visita Única (se não registrou na sessão local recentemente)
    if(!sessionStorage.getItem('visit_logged')) {
      fetch('/api/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affiliate_id: ref })
      }).catch(e => console.error(e));
      sessionStorage.setItem('visit_logged', 'true');
    }
  }

  // Obter quem é o afiliado ativo verificando ambos Storage e Cookie
  const activeAffiliate = localStorage.getItem('affiliate_ref') || getCookie('affiliate_ref');

  // Identificador do cliente
  const visitorId = localStorage.getItem('visitor_session') || ('Lead_' + Math.floor(Math.random() * 10000));
  localStorage.setItem('visitor_session', visitorId);

  // 2. INTERCEPTAR CLIQUES NO WHATSAPP PARA REGISTRAR LEAD
  const waLinks = document.querySelectorAll('a[href^="https://wa.me"]');
  
  waLinks.forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault(); 
      let destination = link.getAttribute('href');

      if (activeAffiliate) {
        // Enviar silenciosamente o registro de Lead para o banco
        try {
          await fetch('/api/lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              affiliate_id: activeAffiliate,
              client_contact: visitorId
            })
          });
        } catch (error) {
          console.error("Erro no rastreamento interno do lead");
        }
        
        // Embutir o Código Rastreável na mensagem do WhatsApp
        const defaultText = "Olá, tenho interesse em escalar minhas vendas.";
        const protocolText = `\n\n(Protocolo de Atendimento: #${visitorId.replace('Lead_','')})`;
        
        if(destination.includes('?text=')) {
          destination += encodeURIComponent(protocolText);
        } else {
          destination += `?text=${encodeURIComponent(defaultText + protocolText)}`;
        }
      }
      
      // Prossegue para o WhatsApp com a mensagem modificada
      window.open(destination, '_blank');
    });
  });
});
